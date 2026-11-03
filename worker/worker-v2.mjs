import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {adminLoginV2} from './login-v2.mjs';
import {publishableKey,supabaseUrl} from './config.js';
import {MuseAdapterV2} from './muse-adapter-v2.mjs';
import {SpeechAuditor} from './speech-audit.mjs';
import {failBrandJobV2,processBrandJobV2} from './workflow-v2.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const dataDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'data'),downloadsDir=path.join(dataDir,'downloads');
// Keep the admin session in memory for this process; do not reuse v1's token file.
const supabase=createClient(supabaseUrl,publishableKey,{auth:{persistSession:false,autoRefreshToken:true,detectSessionInUrl:false}});
const muse=new MuseAdapterV2(path.join(dataDir,'muse-profile'),downloadsDir);
const auditor=new SpeechAuditor({backend:process.env.MUSE_ASR_BACKEND||'native',container:process.env.MUSE_ASR_CONTAINER,modelRoot:process.env.MUSE_ASR_MODEL});
const workerId=randomUUID();let token=null,timer=null,lost=false,renewing=false;
async function call(name,args){const result=await supabase.rpc(name,args);if(result.error)throw result.error;return result.data;}
async function renew(){
  if(renewing||lost)return;renewing=true;
  try{await call('renew_muse_worker',{p_worker:workerId,p_token:token});}
  catch(error){lost=true;console.error('Mất quyền worker; dừng cửa sổ Muse:',error.message);await muse.close().catch(()=>{});}
  finally{renewing=false;}
}
try{
  await auditor.checkAvailable();await adminLoginV2(supabase);await muse.waitForLogin();
  if(process.argv.includes('--diagnose'))console.log('MUSE_CHECK_OK');
  else{
    while(!token){const lease=await call('acquire_muse_worker',{p_worker:workerId});token=lease?.token||null;if(!token){console.log('Worker khác đang hoạt động; chờ đến lượt.');await sleep(10000);}}
    await renew();if(lost)throw Error('Không thể giữ quyền worker.');
    timer=setInterval(()=>void renew(),20000);
    console.log('Worker v2 đã sẵn sàng. Giữ cửa sổ này và Muse mở.');
    while(!lost){
      const job=await call('claim_brand_job_v2',{p_worker:workerId,p_token:token});
      if(!job?.id){await sleep(5000);continue;}
      try{await processBrandJobV2(job,{client:supabase,muse,auditor,workRoot:downloadsDir,workerId,leaseToken:token});console.log('Hoàn tất yêu cầu',job.id);}
      catch(error){
        console.error('Yêu cầu lỗi',job.id,error.message);
        if(!lost)await failBrandJobV2(job,error,{client:supabase,workerId,leaseToken:token}).catch(err=>console.error('Không lưu được lỗi:',err.message));
      }
    }
  }
}catch(error){console.error('Không chạy được worker:',error.message);process.exitCode=1;}
finally{
  if(timer)clearInterval(timer);
  if(token&&!lost)await call('release_muse_worker',{p_worker:workerId,p_token:token}).catch(()=>{});
  await muse.close().catch(()=>{});supabase.auth.stopAutoRefresh();
}
