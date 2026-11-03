import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {checkTranscript} from '../shared/storyboard.mjs';
function run(binary,args,{stdin,timeout=180000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';
  const timer=setTimeout(()=>{child.kill();reject(Object.assign(Error('Bộ kiểm tra lời thoại quá thời gian.'),{code:'ASR_TIMEOUT'}));},timeout);
  child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err=(err+s).slice(-3000));
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(Object.assign(Error('Không kiểm tra được âm thanh: '+err.slice(-300)),{code:'ASR_UNAVAILABLE'}));});
  child.stdin.end(stdin||'');
 });
}
export class SpeechAuditor{
 constructor(config={}){this.config=config;}
 async checkAvailable(){
  const check="import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('faster_whisper') else 2)";
  if(this.config.backend==='docker'){
   const container=this.config.container||'fb-whisper';
   if(!/^[a-zA-Z0-9_.-]+$/.test(container))throw Error('Tên bộ kiểm tra giọng nói không hợp lệ.');
   await run('docker',['exec',container,'python','-c',check],{timeout:60000});
  }else await run(this.config.python||process.env.MUSE_ASR_PYTHON||'python',['-c',check],{timeout:60000});
 }
 async transcribe(file){
  const script=fileURLToPath(new URL('./transcribe.py',import.meta.url));let raw;
  if(this.config.backend==='docker'){
   const container=this.config.container||'fb-whisper';
   if(!/^[a-zA-Z0-9_.-]+$/.test(container))throw Error('Tên bộ kiểm tra giọng nói không hợp lệ.');
   const temp='/tmp/muse-audio-'+randomUUID()+path.extname(file);
   await run('docker',['cp',file,container+':'+temp]);
   try{raw=await run('docker',['exec','-i',container,'python','-',temp,this.config.modelRoot||'/models/hub'],{stdin:await readFile(script,'utf8'),timeout:600000});}
   finally{await run('docker',['exec',container,'python','-c','import os,sys; os.remove(sys.argv[1])',temp]).catch(()=>{});}
  }else{
   raw=await run(this.config.python||process.env.MUSE_ASR_PYTHON||'python',[script,file,...(this.config.modelRoot?[this.config.modelRoot]:[])],{timeout:600000});
  }
  const data=JSON.parse(raw.trim().split('\n').at(-1));
  if(typeof data.text!=='string'||!Array.isArray(data.words))throw Error('Kết quả nhận dạng âm thanh không hợp lệ.');
  return data;
 }
 async verify(file,scene,seconds){
  const transcript=await this.transcribe(file);
  return {...checkTranscript(scene.dialogue,transcript.text,transcript.words,seconds),transcript:transcript.text,words:transcript.words,engine:transcript.engine,model:transcript.model,verified_at:new Date().toISOString()};
 }
}
