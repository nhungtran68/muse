import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {adminLoginV2} from './login-v2.mjs';
import {publishableKey,supabaseUrl} from './config.js';
import {MuseAdapterV2} from './muse-adapter-v2.mjs';
import {SpeechAuditor} from './speech-audit.mjs';
import {checkMediaToolsAvailable} from './ffmpeg.mjs';
import {failBrandJobV2,processBrandJobV2,processBrandScriptV3} from './workflow-v2.mjs';
import {claimNextBrandJob} from './queue.mjs';
import {persistJobFailure} from './job-failure.mjs';
import {LeaseGuard} from './lease-guard.mjs';
import {runtimeDataDir,encryptedSessionStorage,acquireInstanceLock} from './runtime-state.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const workerVersion=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8')).version;
const dataDir=runtimeDataDir(),downloadsDir=path.join(dataDir,'downloads');
let releaseInstance;
try{releaseInstance=await acquireInstanceLock(dataDir);}catch(error){console.log(error.message);process.exit(error.code==='WORKER_ALREADY_RUNNING'?2:1);}
const supabase=createClient(supabaseUrl,publishableKey,{auth:{persistSession:true,storageKey:'muse-brand-worker-admin-v1',storage:encryptedSessionStorage(path.join(dataDir,'auth')),autoRefreshToken:true,detectSessionInUrl:false}});
const muse=new MuseAdapterV2(path.join(dataDir,'muse-profile'),downloadsDir);
const auditor=new SpeechAuditor({backend:process.env.MUSE_ASR_BACKEND||'native',container:process.env.MUSE_ASR_CONTAINER,modelRoot:process.env.MUSE_ASR_MODEL});
const workerId=randomUUID(),leaseGuard=new LeaseGuard();let token=null,timer=null,safetyTimer=null,lost=false,renewing=false,currentState='starting',requestedStop=false;
async function requestStop(){requestedStop=true;lost=true;await muse.close().catch(()=>{});}
process.on('SIGINT',()=>void requestStop());process.on('SIGTERM',()=>void requestStop());
process.on('message',message=>{if(message==='shutdown')void requestStop();});
async function startupStatus(state,error){
  currentState=state;
  await mkdir(dataDir,{recursive:true});
  await writeFile(path.join(dataDir,'startup-status.json'),JSON.stringify({state,version:workerVersion,pid:process.pid,worker_id:workerId,time:new Date().toISOString(),...(error?{code:error.code||'STARTUP_ERROR',message:String(error.message||'').split('\n')[0].replace(/[A-Za-z0-9_-]{40,}/g,'[redacted]').slice(0,300)}:{})}));
}
async function call(name,args){const result=await supabase.rpc(name,args);if(result.error)throw result.error;return result.data;}
async function stopForLease(error){
  if(lost)return;lost=true;
  await startupStatus('error',error).catch(()=>{});
  console.error('Mất quyền worker; dừng cửa sổ Muse:',error.message);
  await muse.close().catch(()=>{});
}
async function renew(){
  if(renewing||lost)return false;renewing=true;
  const started=Date.now();
  try{
    await call('renew_muse_worker',{p_worker:workerId,p_token:token});
    if(!lost&&!leaseGuard.confirm(started))await stopForLease(Error('Gia hạn quyền worker quá chậm.'));
    return !lost;
  }
  catch(error){
    if(leaseGuard.mustStop(error))await stopForLease(error);
    else console.warn('Kết nối gia hạn worker gián đoạn; sẽ thử lại trong thời hạn quyền hiện tại.');
    return false;
  }
  finally{renewing=false;}
}
try{
  await startupStatus('checking_tools');await checkMediaToolsAvailable();await auditor.checkAvailable();
  await startupStatus('waiting_admin_login');await adminLoginV2(supabase,{interactive:!process.argv.includes('--unattended')&&Boolean(process.stdin.isTTY)});
  await startupStatus('waiting_muse_login');await muse.waitForLogin({timeoutMs:Number(process.env.MUSE_LOGIN_TIMEOUT_MS)||600000});
  if(process.argv.includes('--diagnose'))console.log('MUSE_CHECK_OK');
  else{
    await startupStatus('waiting_worker_lease');
    while(!token&&!lost){
      const started=Date.now(),lease=await call('acquire_muse_worker',{p_worker:workerId});
      token=lease?.token||null;
      if(token&&!leaseGuard.confirm(started))throw Error('Nhận quyền worker quá chậm.');
      if(!token){console.log('Worker khác đang hoạt động; chờ đến lượt.');await sleep(10000);}
    }
    while(!lost&&!(await renew()))await sleep(5000);
    if(lost)throw Error('Không thể giữ quyền worker.');
    timer=setInterval(()=>void renew(),20000);
    safetyTimer=setInterval(()=>{if(!lost&&!leaseGuard.current())void stopForLease(Error('Quyền worker sắp hết hạn và chưa gia hạn được.'));},5000);
    await startupStatus('ready');
    console.log(`Worker đã sẵn sàng (bản ${workerVersion}). Giữ cửa sổ này và Muse mở.`);
    while(!lost){
      // Reopen the same persistent profile before claiming customer work if
      // Chrome was closed or the Muse session requires authentication again.
      let composerReady=false;try{composerReady=await muse.composer().isVisible();}catch{}
      if(!composerReady){
        await startupStatus('waiting_muse_login');await muse.waitForLogin();
        if(lost)break;await startupStatus('ready');
      }else await muse.assertConnected();
      // A failed claim may have succeeded remotely. Never blindly resubmit it.
      const job=await claimNextBrandJob(call,{p_worker:workerId,p_token:token});
      if(lost)break;
      if(!job?.id){await sleep(5000);continue;}
      try{
        if(job.schema_version===3&&job.workflow_phase==='script')await processBrandScriptV3(job,{client:supabase,muse,workRoot:downloadsDir,workerId,leaseToken:token});
        else await processBrandJobV2(job,{client:supabase,muse,auditor,workRoot:downloadsDir,workerId,leaseToken:token});
        console.log(job.schema_version===3&&job.workflow_phase==='script'?'Kịch bản chờ khách duyệt':'Hoàn tất yêu cầu',job.id);
      }
      catch(error){
        console.error('Yêu cầu lỗi',job.id,error.message);
        if(!lost)await persistJobFailure({
          persist:()=>failBrandJobV2(job,error,{client:supabase,workerId,leaseToken:token}),
          stop:writeError=>stopForLease(Error(`Không lưu được trạng thái lỗi của yêu cầu ${job.id}: ${writeError?.message||'lỗi kết nối cơ sở dữ liệu'}`))
        });
      }
    }
  }
}catch(error){if(requestedStop)await startupStatus('stopped').catch(()=>{});else{await startupStatus('error',error).catch(()=>{});console.error('Không chạy được worker:',error.message);process.exitCode=1;}}
finally{
  if(timer)clearInterval(timer);
  if(safetyTimer)clearInterval(safetyTimer);
  if(token)await call('release_muse_worker',{p_worker:workerId,p_token:token}).catch(()=>{});
  await muse.close().catch(()=>{});supabase.auth.stopAutoRefresh();
  if(currentState!=='error')await startupStatus('stopped').catch(()=>{});
  await releaseInstance();
  if(process.connected)process.disconnect();
}
