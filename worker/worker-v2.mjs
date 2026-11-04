import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {adminLoginV2} from './login-v2.mjs';
import {publishableKey,supabaseUrl} from './config.js';
import {MuseAdapterV2} from './muse-adapter-v2.mjs';
import {SpeechAuditor} from './speech-audit.mjs';
import {checkMediaToolsAvailable} from './ffmpeg.mjs';
import {failBrandJobV2,processBrandJobV2,processBrandScriptV3} from './workflow-v2.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const workerVersion=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8')).version;
const dataDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'data'),downloadsDir=path.join(dataDir,'downloads');
// Keep the admin session in memory for this process; do not reuse v1's token file.
const supabase=createClient(supabaseUrl,publishableKey,{auth:{persistSession:false,autoRefreshToken:true,detectSessionInUrl:false}});
const muse=new MuseAdapterV2(path.join(dataDir,'muse-profile'),downloadsDir);
const auditor=new SpeechAuditor({backend:process.env.MUSE_ASR_BACKEND||'native',container:process.env.MUSE_ASR_CONTAINER,modelRoot:process.env.MUSE_ASR_MODEL});
const workerId=randomUUID();let token=null,timer=null,lost=false,renewing=false;
async function startupStatus(state,error){
  await mkdir(dataDir,{recursive:true});
  await writeFile(path.join(dataDir,'startup-status.json'),JSON.stringify({state,version:workerVersion,worker_id:workerId,time:new Date().toISOString(),...(error?{code:error.code||'STARTUP_ERROR',message:String(error.message||'').split('\n')[0].replace(/[A-Za-z0-9_-]{40,}/g,'[redacted]').slice(0,300)}:{})}));
}
async function call(name,args){const result=await supabase.rpc(name,args);if(result.error)throw result.error;return result.data;}
async function renew(){
  if(renewing||lost)return;renewing=true;
  try{await call('renew_muse_worker',{p_worker:workerId,p_token:token});}
  catch(error){lost=true;console.error('Mất quyền worker; dừng cửa sổ Muse:',error.message);await muse.close().catch(()=>{});}
  finally{renewing=false;}
}
try{
  await startupStatus('checking_tools');await checkMediaToolsAvailable();await auditor.checkAvailable();
  await startupStatus('waiting_admin_login');await adminLoginV2(supabase);
  await startupStatus('waiting_muse_login');await muse.waitForLogin();
  if(process.argv.includes('--diagnose'))console.log('MUSE_CHECK_OK');
  else{
    await startupStatus('waiting_worker_lease');
    while(!token){const lease=await call('acquire_muse_worker',{p_worker:workerId});token=lease?.token||null;if(!token){console.log('Worker khác đang hoạt động; chờ đến lượt.');await sleep(10000);}}
    await renew();if(lost)throw Error('Không thể giữ quyền worker.');
    timer=setInterval(()=>void renew(),20000);
    await startupStatus('ready');
    console.log(`Worker đã sẵn sàng (bản ${workerVersion}). Giữ cửa sổ này và Muse mở.`);
    while(!lost){
      const job=await call('claim_brand_job_v3',{p_worker:workerId,p_token:token})||await call('claim_brand_job_v2',{p_worker:workerId,p_token:token});
      if(!job?.id){await sleep(5000);continue;}
      try{
        if(job.schema_version===3&&job.workflow_phase==='script')await processBrandScriptV3(job,{client:supabase,muse,workRoot:downloadsDir,workerId,leaseToken:token});
        else await processBrandJobV2(job,{client:supabase,muse,auditor,workRoot:downloadsDir,workerId,leaseToken:token});
        console.log(job.schema_version===3&&job.workflow_phase==='script'?'Kịch bản chờ khách duyệt':'Hoàn tất yêu cầu',job.id);
      }
      catch(error){
        console.error('Yêu cầu lỗi',job.id,error.message);
        if(!lost)await failBrandJobV2(job,error,{client:supabase,workerId,leaseToken:token}).catch(err=>console.error('Không lưu được lỗi:',err.message));
      }
    }
  }
}catch(error){await startupStatus('error',error).catch(()=>{});console.error('Không chạy được worker:',error.message);process.exitCode=1;}
finally{
  if(timer)clearInterval(timer);
  if(token&&!lost)await call('release_muse_worker',{p_worker:workerId,p_token:token}).catch(()=>{});
  await muse.close().catch(()=>{});supabase.auth.stopAutoRefresh();
}
