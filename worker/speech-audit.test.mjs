import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechAuditor,speechVocabulary} from './speech-audit.mjs';

const dialogue='Xin chào mọi người thân mến, chào mừng mọi người đã đến với video hôm nay. Hôm nay mình xin giới thiệu về Đại Ngân Farm ạ.';
const scene={dialogue,source_quotes:['Giơi thiệu về đại ngân farm']};
const transcript=(text,end)=>({text,words:[{word:'Xin',start:.46,end:.94},{word:'end',start:end-.1,end}],engine:'test',model:'fixture'});
const baseline=dialogue.replace('Đại Ngân Farm ạ','đại ngân pha mà');
function auditor(responses){
 const instance=new SpeechAuditor(),calls=[];
 instance.transcribe=async(file,options)=>{calls.push(options||{});assert.equal(file,'clip.mp4');assert.ok(responses.length,'Unexpected transcription');return responses.shift();};
 return {instance,calls};
}

test('rechecks a grounded brand spelling without feeding the expected sentence into recognition',async()=>{
 const {instance,calls}=auditor([transcript(baseline,7.54),transcript(dialogue,7.62)]);
 const result=await instance.verify('clip.mp4',scene,10);
 assert.equal(result.ok,true);assert.equal(result.verification,'grounded_vocabulary');
 assert.deepEqual(calls,[{},{vocabulary:['Đại Ngân Farm']}]);
 assert.equal(result.baseline.reason,'CUT_OFF_SPEECH');assert.equal(result.word_error_rate,0);
 assert.equal(result.baseline.transcript,baseline);
});

test('a missing closing word or a hinted ending beyond the detected audio still fails',async()=>{
 const cut=dialogue.replace('Đại Ngân Farm ạ','Đại gân');
 const hintedCut=dialogue.replace('Farm ạ','Farm');
 let probe=auditor([transcript(cut,7.14),transcript(hintedCut,7.30)]);
 let result=await probe.instance.verify('clip.mp4',scene,10);
 assert.equal(result.ok,false);assert.equal(result.reason,'CUT_OFF_SPEECH');
 probe=auditor([transcript(cut,7.14),transcript(dialogue,7.31)]);
 result=await probe.instance.verify('clip.mp4',scene,10);
 assert.equal(result.ok,false);assert.equal(result.verification,'unprompted');
});

test('never hints ungrounded names, an entire sentence, or a name that forms the whole ending',async()=>{
 assert.deepEqual(speechVocabulary({...scene,source_quotes:['Một thương hiệu khác']}),[]);
 const titleCase=dialogue.replace(/(^|\s)(\p{L})/gu,(_m,space,letter)=>space+letter.toUpperCase());
 const hinted=speechVocabulary({dialogue:titleCase,source_quotes:[titleCase]});
 assert.ok(hinted.join(' ').split(' ').filter(Boolean).length<=Math.floor(titleCase.split(/\s+/).length*.25));
 const terminal={...scene,dialogue:dialogue.replace(' ạ.','.')};
 const probe=auditor([transcript(terminal.dialogue.replace('Farm','pha'),7.54)]);
 assert.equal((await probe.instance.verify('clip.mp4',terminal,10)).ok,false);
 assert.equal(probe.calls.length,1);
});
