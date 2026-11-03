import test from 'node:test';
import assert from 'node:assert/strict';
import {checkTranscript,estimateSpeech,normalizeSpeech,parseMarkedJson,validateStoryboard} from './storyboard.mjs';

const job={id:'01234567-89ab-cdef-0123-456789abcdef',content:'Nho tươi được trồng trên giàn xanh, từng chùm nho tím xuất hiện dưới ánh nắng nhẹ. Mời bạn đến thăm vườn nho và cùng thưởng thức những chùm nho tươi ngay tại vườn.',scene_count:2,scene_seconds:10};
const fixture=()=>({id:'PLAN_01234567_89ab_cdef_0123_456789abcdef',schema_version:2,analysis:{topic:'Nho',message:'Giới thiệu nho',character:'Người giới thiệu',context:'Giàn nho',purpose:'Mời thưởng thức'},outline:'Giới thiệu giàn nho và mời thưởng thức.',scenes:[{index:1,seconds:10,prompt:'Máy quay chậm qua giàn nho xanh mát.',dialogue:'Nho tươi được trồng trên giàn xanh, từng chùm nho tím xuất hiện dưới ánh nắng nhẹ.',action:'Máy quay lia chậm qua những chùm nho.',source_quotes:['Nho tươi được trồng trên giàn xanh']},{index:2,seconds:10,prompt:'Người giới thiệu cầm chùm nho tự nhiên.',dialogue:'Mời bạn đến thăm vườn nho và cùng thưởng thức những chùm nho tươi ngay tại vườn.',action:'Người giới thiệu mỉm cười và cầm chùm nho.',source_quotes:['Mời bạn đến thăm vườn nho']}]});

test('checks raw source, scene order and dialogue duration',()=>{
  assert.equal(validateStoryboard(fixture(),job).scenes.length,2);
  const unsupported=fixture();unsupported.scenes[0].source_quotes=['Không có trong nội dung'];
  assert.throws(()=>validateStoryboard(unsupported,job),{code:'UNSUPPORTED_SOURCE'});
  const invented=fixture();invented.scenes[0].dialogue+=' Nho được bảo hành 100%.';
  assert.throws(()=>validateStoryboard(invented,job),{code:'INVENTED_CLAIM'});
  const long=fixture();long.scenes[0].dialogue=Array(60).fill('nho').join(' ');
  assert.throws(()=>validateStoryboard(long,job),{code:'SPEECH_TOO_LONG'});
  const short=fixture();short.scenes[0].dialogue='Nho tươi.';
  assert.throws(()=>validateStoryboard(short,job),{code:'SPEECH_TOO_SHORT'});
  const repeated=fixture();repeated.scenes[1].dialogue=repeated.scenes[0].dialogue;
  assert.throws(()=>validateStoryboard(repeated,job),{code:'REPEATED_DIALOGUE'});
});
test('recognizes Vietnamese đ and expands numbers for estimates',()=>{
  assert.equal(normalizeSpeech('Đọc đúng'), 'doc dung');
  assert.ok(estimateSpeech('12 kg',10).units>2);
});
test('accepts only matching speech with a complete ending inside duration',()=>{
  const words=[{start:.1,end:1.5},{start:1.5,end:5}];
  assert.equal(checkTranscript('Mời bạn thưởng thức', 'Mời bạn thưởng thức',words,10).ok,true);
  assert.equal(checkTranscript('Mời bạn thưởng thức', 'Mời bạn',words,10).ok,false);
  assert.equal(checkTranscript('Mời bạn thưởng thức', 'Mời bạn thưởng thức',[{start:0,end:10}],10).ok,false);
  assert.equal(checkTranscript('Mời bạn thưởng thức', 'Mời bạn thưởng thức',[{start:1,end:3}],10).reason,'SPEECH_TOO_SHORT');
  assert.equal(checkTranscript('', 'Xin chào',words,10).ok,false);
});
test('extracts matching JSON despite unrelated text',()=>{
  const data=fixture(),input='text '+JSON.stringify(data)+' trailing';
  assert.deepEqual(parseMarkedJson(input,data.id),data);
  assert.equal(parseMarkedJson(input,'other'),null);
});
