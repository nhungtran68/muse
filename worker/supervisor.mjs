import {spawn} from 'node:child_process';
import {existsSync,createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,stat,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeDataDir,acquireInstanceLock} from './runtime-state.mjs';

const dataDir=runtimeDataDir(),appDir=path.dirname(fileURLToPath(import.meta.url));
let release;try{release=await acquireInstanceLock(dataDir,'supervisor');}catch(error){console.log(error.message);process.exit(error.code==='WORKER_ALREADY_RUNNING'?0:1);}
await mkdir(path.join(dataDir,'logs'),{recursive:true});
const logfile=path.join(dataDir,'logs','worker.log');
if((await stat(logfile).catch(()=>({size:0}))).size>5*1024*1024)await rename(logfile,logfile+'.previous').catch(()=>{});
const log=createWriteStream(logfile,{flags:'a'}),pause=ms=>new Promise(r=>setTimeout(r,ms));
let stopping=false,child=null,lastDockerLaunch=0,lastState='';
function record(message){log.write(new Date().toISOString()+' '+String(message).replace(/[A-Za-z0-9_-]{80,}/g,'[redacted]')+'\n');}
async function state(value){if(lastState!==value){record(value);lastState=value;}await writeFile(path.join(dataDir,'supervisor-status.json'),JSON.stringify({state:value,pid:process.pid,worker_pid:child?.pid||null,time:new Date().toISOString()}));}
function command(args,timeout=15000){return new Promise(resolve=>{
  const p=spawn('docker',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  const timer=setTimeout(()=>{p.kill();resolve({ok:false,output:'timeout'});},timeout);
  p.stdout.on('data',x=>output=(output+x).slice(-1000));p.stderr.resume();
  p.once('error',()=>{clearTimeout(timer);resolve({ok:false,output:'unavailable'});});
  p.once('close',code=>{clearTimeout(timer);resolve({ok:code===0,output:output.trim()});});
});}
async function stop(){if(stopping)return;stopping=true;record('Stopping supervisor');if(child?.connected)child.send('shutdown');}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
try{
  while(!stopping){
    if(existsSync(path.join(dataDir,'stop.request'))){await stop();break;}
    if(existsSync(path.join(dataDir,'setup.pending'))){await state('waiting_setup');await pause(3000);continue;}
    if(!(await command(['info','--format','{{.ServerVersion}}'])).ok){
      await state('waiting_docker');
      if(process.platform==='win32'&&Date.now()-lastDockerLaunch>120000){
        const desktop=path.join(process.env.PROGRAMFILES||'C:\\Program Files','Docker','Docker','Docker Desktop.exe');
        if(existsSync(desktop)){const p=spawn(desktop,[],{detached:true,windowsHide:true,stdio:'ignore'});p.on('error',()=>{});p.unref();}
        lastDockerLaunch=Date.now();
      }
      await pause(10000);continue;
    }
    const container=process.env.MUSE_ASR_CONTAINER||'fb-whisper';
    const inspected=await command(['inspect',container,'--format','{{.State.Running}}']);
    if(!inspected.ok){await state('asr_container_missing');await pause(15000);continue;}
    if(inspected.output!=='true')await command(['start',container],30000);
    if(!(await command(['exec',container,'python','-c','import faster_whisper'],60000)).ok){await state('waiting_asr');await pause(10000);continue;}
    await state('starting_worker');
    child=spawn(process.execPath,[path.join(appDir,'worker-v2.mjs'),'--unattended'],{cwd:appDir,windowsHide:true,env:{...process.env,MUSE_ASR_BACKEND:'docker',MUSE_WORKER_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe','ipc']});
    child.stdout.on('data',x=>record(x.toString().trimEnd()));child.stderr.on('data',x=>record(x.toString().trimEnd()));
    await state('worker_running');
    let checking=false,failures=0,ticks=0;
    const watch=setInterval(async()=>{
      if(existsSync(path.join(dataDir,'stop.request'))){void stop();return;}
      if(checking||++ticks%10!==0||stopping)return;
      checking=true;
      try{
        const health=await command(['inspect',container,'--format','{{.State.Running}}'],8000);
        failures=health.ok&&health.output==='true'?0:failures+1;
        if(failures>=2&&child?.connected){record('Docker/ASR unavailable; pausing worker until recovery');child.send('shutdown');}
      }finally{checking=false;}
    },1000);
    await new Promise(resolve=>{child.once('error',error=>{record('Cannot start worker: '+error.message);resolve();});child.once('close',code=>{record('Worker exited: '+code);resolve();});});
    clearInterval(watch);child=null;
    if(stopping)break;
    const status=await readFile(path.join(dataDir,'startup-status.json'),'utf8').then(JSON.parse).catch(()=>({}));
    await state('waiting_retry');
    await pause(status.code==='ADMIN_LOGIN_REQUIRED'?60000:15000);
  }
}finally{await state('stopped');await release();log.end();}
