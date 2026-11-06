// Staging-only integration test. Reads temporary fixture credentials from stdin.
// It sends no request to Muse and touches only the newly created test job.
import {createClient} from '@supabase/supabase-js';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {uploadMedia,downloadMedia,signedMediaUrl} from '../shared/media-storage.mjs';

if(process.stdin.isTTY)process.stdin.setRawMode(true);
console.log('READY_FOR_R2_STAGING_TEST');
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.includes('\n')||input.includes('\r'))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const {url,key,accounts,gateway,videoPath}=JSON.parse(input);
if(!url.startsWith('https://tgxuwjljfbalozgaslwq.supabase.co'))throw Error('Staging project required');
const clients={};
for(const account of accounts){
  const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const {error}=await client.auth.signInWithPassword({email:account.email,password:account.password});
  if(error)throw Error(`Fixture login failed: ${account.test_role}: ${error.message}`);
  clients[account.test_role]=client;
}
const rpc=async(client,name,args)=>{const r=await client.rpc(name,args);if(r.error)throw Error(`${name}: ${r.error.message}`);return r.data;};
const member=clients.member,other=clients.other,admin=clients.admin;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/kV8AAAAASUVORK5CYII=','base64');
const jobId=randomUUID();
const job=await rpc(member,'submit_single_media_job',{p_id:jobId,p_request_key:randomUUID(),p_content:'Kiểm tra riêng tư và tải video lên kho R2',p_mode:'video_free',p_reference_sha256:hash(png)});
if(job.id!==jobId||job.storage_provider!=='r2'||job.reference_storage_provider!=='r2')throw Error('Staging R2 job provider mismatch');
console.log('R2_STAGE_JOB_CREATED:'+jobId);
const reference={provider:'r2',bucket:'brand-references',path:job.reference_path,jobId,origin:gateway};
await uploadMedia(member,{...reference,contentType:'image/png',data:png});
const refUrl=await signedMediaUrl(member,reference),refResponse=await fetch(refUrl);
if(!refResponse.ok||hash(Buffer.from(await refResponse.arrayBuffer()))!==hash(png))throw Error('Reference image mismatch');
try{await signedMediaUrl(other,reference);throw Error('Other member saw reference');}
catch(error){if(error.message==='Other member saw reference')throw error;}
await rpc(member,'queue_brand_job',{p_id:jobId});
const workerId=randomUUID(),lease=await rpc(admin,'acquire_muse_worker',{p_worker:workerId});
if(!lease?.token)throw Error('Staging worker lease unavailable');
try{
  await rpc(admin,'register_r2_worker',{p_worker:workerId,p_token:lease.token});
  const claimed=await rpc(admin,'claim_brand_job_v2',{p_worker:workerId,p_token:lease.token});
  if(claimed?.id!==jobId)throw Error('Wrong staging job claimed');
  const auth={p_id:jobId,p_worker:workerId,p_token:lease.token,p_claim:claimed.claim_token};
  await rpc(admin,'update_brand_job_v2',{...auth,p_patch:{status:'generating'}});
  const video=await readFile(videoPath),outputPath=`${job.user_id}/${jobId}/${claimed.claim_token}/result.mp4`;
  const output={provider:'r2',bucket:'brand-videos',path:outputPath,jobId,origin:gateway};
  await uploadMedia(admin,{...output,contentType:'video/mp4',data:video});
  await rpc(admin,'complete_single_media_job',{...auth,p_path:outputPath,p_sha256:hash(video),
    p_probe:{kind:'video',width:720,height:1280,duration:1,content_type:'video/mp4'}});
  const resultBytes=Buffer.from(await (await downloadMedia(member,output)).arrayBuffer());
  if(hash(resultBytes)!==hash(video))throw Error('Video bytes mismatch');
  try{await signedMediaUrl(other,output);throw Error('Other member saw video');}
  catch(error){if(error.message==='Other member saw video')throw error;}
  console.log('R2_STAGE_UPLOAD_DOWNLOAD_AND_USER_ISOLATION_OK');
}finally{await rpc(admin,'release_muse_worker',{p_worker:workerId,p_token:lease.token}).catch(()=>{});}
