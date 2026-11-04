import test from 'node:test';
import assert from 'node:assert/strict';
import {checkTranscript,estimateSpeech,normalizeSpeech,parseMarkedJson,validateStoryboard} from './storyboard.mjs';

const job={id:'01234567-89ab-cdef-0123-456789abcdef',content:'Nho tươi được trồng trên giàn xanh, từng chùm nho tím xuất hiện dưới ánh nắng nhẹ. Mời bạn đến thăm vườn nho và cùng thưởng thức những chùm nho tươi ngay tại vườn.',scene_count:2,scene_seconds:10};
const fixture=()=>({id:'PLAN_01234567_89ab_cdef_0123_456789abcdef',schema_version:2,analysis:{topic:'Nho',message:'Giới thiệu nho',character:'Người giới thiệu',context:'Giàn nho',purpose:'Mời thưởng thức'},outline:'Giới thiệu giàn nho và mời thưởng thức.',scenes:[{index:1,seconds:10,prompt:'Máy quay chậm qua giàn nho xanh mát.',dialogue:'Nho tươi được trồng trên giàn xanh, từng chùm nho tím xuất hiện dưới ánh nắng nhẹ.',action:'Máy quay lia chậm qua những chùm nho.',source_quotes:['Nho tươi được trồng trên giàn xanh']},{index:2,seconds:10,prompt:'Người giới thiệu cầm chùm nho tự nhiên.',dialogue:'Mời bạn đến thăm vườn nho, ngắm những chùm nho tím ngay trên giàn xanh và cùng thưởng thức nho tươi ngay tại vườn.',action:'Người giới thiệu mỉm cười và cầm chùm nho.',source_quotes:['Mời bạn đến thăm vườn nho']}]});

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
  const words=[{start:.1,end:1.5},{start:1.5,end:6.5}];
  assert.equal(checkTranscript('Mời bạn thưởng thức', 'Mời bạn thưởng thức',words,10).ok,true);
  assert.equal(checkTranscript('Mời bạn thưởng thức', 'Mời bạn',words,10).ok,false);
  assert.equal(checkTranscript('Mời bạn thưởng thức', 'Mời bạn thưởng thức',[{start:0,end:10}],10).ok,false);
  assert.equal(checkTranscript('Mời bạn thưởng thức', 'Mời bạn thưởng thức',[{start:1,end:3}],10).reason,'SPEECH_TOO_SHORT');
  assert.equal(checkTranscript('Mời bạn thưởng thức', 'Mời bạn thưởng thức',[{start:.1,end:5.1}],10).reason,'SPEECH_TOO_SHORT');
  assert.equal(checkTranscript('', 'Xin chào',words,10).ok,false);
});

test('accepts a one-letter ASR variant in an otherwise complete ending, never a missing final word',()=>{
  const expected='Chất chống oxy hóa giúp tăng năng lượng, hỗ trợ tim mạch và xương khớp.';
  const words=[{start:.3,end:1},{start:8.1,end:8.5}];
  assert.equal(checkTranscript(expected,'Chất trống oxy hóa giúp tăng năng lượng, hỗ trợ tim mạch và sương khớp.',words,10).ok,true);
  assert.equal(checkTranscript(expected,'Chất trống oxy hóa giúp tăng năng lượng, hỗ trợ tim mạch và sương.',words,10).reason,'CUT_OFF_SPEECH');
  assert.equal(checkTranscript('Mình muốn giới thiệu tên thương hiệu đến với mọi người một cách gần gũi.','Mình muốn giới thiệu tên thương hiệu đến với mọi người một cách gần hũi.',words,10).ok,true);
  assert.equal(checkTranscript('Mình muốn giới thiệu tên thương hiệu đến với mọi người một cách gần gũi.','Mình muốn giới thiệu tên thương hiệu đến với mọi người một cách gần.',words,10).reason,'CUT_OFF_SPEECH');
});
test('extracts matching JSON despite unrelated text',()=>{
  const data=fixture(),input='text '+JSON.stringify(data)+' trailing';
  assert.deepEqual(parseMarkedJson(input,data.id),data);
  assert.equal(parseMarkedJson(input,'other'),null);
});

test('accepts an outline array or derives it only from validated scene dialogue',()=>{
  const array=fixture();array.outline=['Giới thiệu giàn nho','Mời ghé thăm vườn'];
  assert.equal(validateStoryboard(array,job).outline,array.outline.join('\n'));
  const missing=fixture();delete missing.outline;
  assert.equal(validateStoryboard(missing,job).outline,missing.scenes.map(scene=>`Cảnh ${scene.index}: ${scene.dialogue}`).join('\n'));
  missing.scenes[0].dialogue='Nho.';
  assert.throws(()=>validateStoryboard(missing,job),{code:'SPEECH_TOO_SHORT'});
});

test('turns a short brand idea into distinct grounded scenes without consuming the source quote',()=>{
  const brief={...job,content:'Giơi thiệu về đại ngân farm',scene_count:3};
  const plan=fixture();
  const lines=[
    'Xin chào mọi người, hôm nay mình rất vui được có mặt trong video này để gửi lời chào và giới thiệu về Đại Ngân Farm.',
    'Trong khung hình này, chiếc nón lá và màu áo xanh cùng nụ cười nhẹ nhàng tạo nên phần hình ảnh cho lời giới thiệu hôm nay.',
    'Cảm ơn bạn đã dành thời gian theo dõi video giới thiệu này. Hẹn gặp lại bạn trong những nội dung tiếp theo về Đại Ngân Farm.'
  ];
  plan.status='ready';
  plan.scenes=lines.map((dialogue,i)=>({...plan.scenes[0],index:i+1,dialogue,source_quotes:[brief.content]}));
  const result=validateStoryboard(plan,brief);
  assert.equal(result.scenes.length,3);
  assert.equal(new Set(result.scenes.map(s=>s.dialogue)).size,3);
  assert.ok(result.scenes.every(s=>s.speech.estimated_seconds>=5&&s.speech.estimated_seconds<9.65));
  plan.scenes[1].dialogue+=' Cam kết bảo hành.';
  assert.throws(()=>validateStoryboard(plan,brief),{code:'INVENTED_CLAIM'});
});

test('rejects the reported placeholder scene before word counts or video generation',()=>{
  const plan=fixture();
  plan.scenes[1].dialogue='[Chưa có lời thoại trong nội dung gốc - cần bổ sung nội dung, không bịa, không lặp cảnh 1]';
  plan.scenes[1].action='Giữ nguyên tư thế ảnh, chờ bổ sung lời thoại nên chưa quay cảnh này';
  plan.scenes[1].source_quotes=[];
  assert.throws(()=>validateStoryboard(plan,job),{code:'CONTENT_INSUFFICIENT',retryable:false});
  assert.throws(()=>validateStoryboard({id:plan.id,schema_version:2,status:'needs_input',scenes:[]},job),{code:'CONTENT_INSUFFICIENT',retryable:false});
});
