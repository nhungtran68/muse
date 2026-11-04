import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {checkTranscript,normalizeSpeech} from '../shared/storyboard.mjs';
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
export function speechVocabulary(scene){
 const source=normalizeSpeech((scene.source_quotes||[]).join(' '));
 const terms=String(scene.dialogue||'').match(/\p{Lu}[\p{L}\p{N}]*(?:\s+\p{Lu}[\p{L}\p{N}]*){1,4}/gu)||[];
 const budget=Math.min(8,Math.floor(normalizeSpeech(scene.dialogue).split(' ').filter(Boolean).length*.25));
 const result=[];let used=0;
 for(const term of new Set(terms)){
  const normalized=normalizeSpeech(term),units=normalized.split(' ').length;
  if(term.length<=60&&used+units<=budget&&(' '+source+' ').includes(' '+normalized+' ')){
   result.push(term);used+=units;
  }
 }
 return result.slice(0,5);
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
 async transcribe(file,{vocabulary=[]}={}){
  const script=fileURLToPath(new URL('./transcribe.py',import.meta.url));let raw;
  if(this.config.backend==='docker'){
   const container=this.config.container||'fb-whisper';
   if(!/^[a-zA-Z0-9_.-]+$/.test(container))throw Error('Tên bộ kiểm tra giọng nói không hợp lệ.');
   const temp='/tmp/muse-audio-'+randomUUID()+path.extname(file);
   await run('docker',['cp',file,container+':'+temp]);
   try{raw=await run('docker',['exec','-i',container,'python','-',temp,this.config.modelRoot||'/models/hub',JSON.stringify(vocabulary)],{stdin:await readFile(script,'utf8'),timeout:600000});}
   finally{await run('docker',['exec',container,'python','-c','import os,sys; os.remove(sys.argv[1])',temp]).catch(()=>{});}
  }else{
   raw=await run(this.config.python||process.env.MUSE_ASR_PYTHON||'python',[script,file,this.config.modelRoot||'',JSON.stringify(vocabulary)],{timeout:600000});
  }
  const data=JSON.parse(raw.trim().split('\n').at(-1));
  if(typeof data.text!=='string'||!Array.isArray(data.words))throw Error('Kết quả nhận dạng âm thanh không hợp lệ.');
  return data;
 }
 async verify(file,scene,seconds){
  let transcript=await this.transcribe(file),check=checkTranscript(scene.dialogue,transcript.text,transcript.words,seconds),baseline=null;
  const vocabulary=speechVocabulary(scene);
  // Never supply the expected sentence. For a terminal name, require both
  // bookends to have been heard already; a missing last word cannot be hinted in.
  const terminal=vocabulary.find(term=>normalizeSpeech(scene.dialogue).endsWith(normalizeSpeech(term)));
  const name=normalizeSpeech(terminal||'').split(' ').filter(Boolean);
  const heard=normalizeSpeech(transcript.text).split(' ').filter(Boolean).slice(-name.length);
  const anchoredName=name.length>=3&&heard.length===name.length&&heard[0]===name[0]&&heard.at(-1)===name.at(-1)
    &&heard.filter((word,i)=>word!==name[i]).length===1;
  if(check.reason==='CUT_OFF_SPEECH'&&check.word_error_rate<=.15&&check.spoken_seconds>=seconds*.60&&vocabulary.length&&(!terminal||anchoredName)){
   const hinted=await this.transcribe(file,{vocabulary}),candidate=checkTranscript(scene.dialogue,hinted.text,hinted.words,seconds);
   if(candidate.ok&&candidate.word_error_rate<check.word_error_rate&&candidate.spoken_end<=check.spoken_end+.12){
    baseline={reason:check.reason,word_error_rate:check.word_error_rate,transcript:transcript.text,spoken_end:check.spoken_end};
    transcript=hinted;check=candidate;
   }
  }
  return {...check,transcript:transcript.text,words:transcript.words,engine:transcript.engine,model:transcript.model,...(baseline?{verification:'grounded_vocabulary',vocabulary,baseline}:{verification:'unprompted'}),verified_at:new Date().toISOString()};
 }
}
