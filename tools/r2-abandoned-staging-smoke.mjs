// Simulates a disconnected reference upload for one disposable staging job.
import {createClient} from '@supabase/supabase-js';
import {createHash,randomUUID} from 'node:crypto';
import {signedMediaUrl} from '../shared/media-storage.mjs';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
console.log('READY_FOR_ABANDONED_CREDENTIALS');
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.includes('\n')||input.includes('\r'))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const {url,key,member,gateway}=JSON.parse(input);
if(!url.startsWith('https://tgxuwjljfbalozgaslwq.supabase.co'))throw Error('Staging project required');
const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const login=await client.auth.signInWithPassword({email:member.email,password:member.password});if(login.error)throw login.error;
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/kV8AAAAASUVORK5CYII=','base64');
const id=randomUUID(),hash=createHash('sha256').update(bytes).digest('hex');
const submitted=await client.rpc('submit_single_media_job',{p_id:id,p_request_key:randomUUID(),p_content:'Kiểm tra dọn file tải dở R2',p_mode:'video_free',p_reference_sha256:hash});
if(submitted.error)throw submitted.error;const job=submitted.data;
const body={action:'put',bucket:'brand-references',path:job.reference_path,jobId:id,contentType:'image/png',size:bytes.length};
const res=await fetch(`${gateway}/api/media`,{method:'POST',headers:{Authorization:`Bearer ${login.data.session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
if(!res.ok)throw Error(`Signing failed: ${res.status}`);
const {url:putUrl}=await res.json();const put=await fetch(putUrl,{method:'PUT',headers:{'Content-Type':'image/png'},body:bytes});if(!put.ok)throw Error(`Upload failed: ${put.status}`);
// Deliberately do not finalize, simulating a browser closing after the PUT.
const getUrl=await signedMediaUrl(client,{provider:'r2',bucket:'brand-references',path:job.reference_path,jobId:id,origin:gateway});
const status=async()=>(await fetch(getUrl,{signal:AbortSignal.timeout(10000)})).status;
if(await status()!==200)throw Error('Fixture not present');
console.log('R2_ABANDONED_OBSERVATION_READY:'+id);
for(let i=0;i<36;i++){await new Promise(resolve=>setTimeout(resolve,5000));if(await status()===404){console.log('R2_ABANDONED_SCHEDULED_DELETE_OK');process.exit(0);}}
throw Error('Abandoned upload deletion was not observed in three minutes');
