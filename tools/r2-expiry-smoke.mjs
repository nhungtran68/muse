// Observe a single disposable staging job without starting its cleanup.
// The scheduler must delete both original objects after the test expires them.
import {createClient} from '@supabase/supabase-js';
import {signedMediaUrl} from '../shared/media-storage.mjs';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
console.log('READY_FOR_EXPIRY_CREDENTIALS');
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.includes('\n')||input.includes('\r'))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const {url,key,member,gateway,jobId}=JSON.parse(input);
if(!url.startsWith('https://tgxuwjljfbalozgaslwq.supabase.co'))throw Error('Staging project required');
const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const login=await client.auth.signInWithPassword({email:member.email,password:member.password});if(login.error)throw login.error;
const job=await client.from('brand_jobs').select('reference_path,final_path').eq('id',jobId).single();if(job.error)throw job.error;
const ref=await signedMediaUrl(client,{provider:'r2',bucket:'brand-references',path:job.data.reference_path,jobId,origin:gateway});
const video=await signedMediaUrl(client,{provider:'r2',bucket:'brand-videos',path:job.data.final_path,jobId,origin:gateway});
const status=async url=>(await fetch(url,{signal:AbortSignal.timeout(10000)})).status;
if(await status(ref)!==200||await status(video)!==200)throw Error('Fixtures missing before expiry');
console.log('R2_EXPIRY_OBSERVATION_READY');
for(let i=0;i<36;i++){
  await new Promise(resolve=>setTimeout(resolve,5000));
  if(await status(ref)===404&&await status(video)===404){console.log('R2_SCHEDULED_EXPIRY_DELETED_BOTH_OBJECTS');process.exit(0);}
}
throw Error('Scheduled deletion was not observed in three minutes');
