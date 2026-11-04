import test from 'node:test';
import assert from 'node:assert/strict';
import {BRAND_VIDEO_TEMPLATE,BRAND_VIDEO_TEMPLATE_VERSION,clipRequest,compileBrandVideoPrompt,validateEditedDialogue} from './brand-video-prompt.mjs';
import {buildStoryboardPrompt,validateStoryboard} from './storyboard.mjs';

const first='Xin chào mọi người, hôm nay mình kể một chút về Đại Ngân Farm, nơi mình muốn chia sẻ câu chuyện này cùng mọi người.';
const second='Từ hình ảnh quen thuộc này, mình mong mọi người cảm nhận được sự gần gũi, rồi cùng lắng nghe phần tiếp theo nha.';
const third='Cảm ơn mọi người đã dành thời gian lắng nghe. Mong rằng câu chuyện nhỏ này sẽ ở lại với bạn thêm một chút nữa.';
const fourth='Nếu bạn muốn tìm hiểu thêm về Đại Ngân Farm, cứ theo dõi những chia sẻ tiếp theo của mình, mình rất vui được đồng hành.';
test('the fixed template fills exactly two and four ten-second segments without rewriting edited text',()=>{
 for(const lines of [[first,second],[first,second,third,fourth]]){
  const prompt=compileBrandVideoPrompt(lines.length,lines);
  assert.match(prompt,new RegExp(`Tạo video gồm ${lines.length} đoạn liên tiếp`));
  assert.match(prompt,new RegExp(`tổng thời lượng ${lines.length*10} giây`));
  assert.equal((prompt.match(/ĐOẠN \d+ – 10 GIÂY:/g)||[]).length,lines.length);
  lines.forEach((line,i)=>assert.ok(prompt.includes(`Lời thoại: “${line}”`),`segment ${i+1} changed`));
  assert.doesNotMatch(prompt,/\{\{|\}\}|…/);
  assert.equal(BRAND_VIDEO_TEMPLATE.includes('{{SO_DOAN}}'),true);
 }
});
test('video requests for 3–6 parts contain only the approved dialogue of that part',()=>{
 for(const count of [3,4,5,6]){
  const lines=[first,second,third,fourth,'Mình rất vui khi được kể câu chuyện này cùng mọi người hôm nay. Cảm ơn bạn đã lắng nghe và ở lại với mình.','Hẹn gặp lại mọi người trong những chia sẻ tiếp theo. Mong bạn luôn có những phút giây thật vui và bình an nha.'].slice(0,count);
  const plan=lines.map((dialogue,i)=>({index:i+1,seconds:10,dialogue}));
  const job={schema_version:3,scene_count:count,scene_seconds:10,plan,video_prompt_version:BRAND_VIDEO_TEMPLATE_VERSION};
  for(const scene of plan){
   const request=clipRequest(job,scene);
   assert.match(request,new RegExp(`ĐOẠN ${scene.index}/${count}`));
   assert.match(request,/khung hình dọc 9:16/);
   assert.match(request,/đọc hết câu vào khoảng giây thứ 8 đến 9/);
   assert.ok(request.includes(`“${scene.dialogue}”`));
   for(const other of plan.filter(part=>part.index!==scene.index))assert.ok(!request.includes(`“${other.dialogue}”`));
   assert.doesNotMatch(request,/\{\{|\}\}|…/);
  }
 }
});
test('the previously sent multi-part prompt is retained only for receipt recovery',()=>{
 const plan=[first,second,third].map((dialogue,i)=>({index:i+1,seconds:10,dialogue}));
 const job={schema_version:3,scene_count:3,scene_seconds:10,plan,video_prompt_version:BRAND_VIDEO_TEMPLATE_VERSION};
 const request=clipRequest(job,plan[1],{legacy:true});
 assert.ok(request.endsWith(compileBrandVideoPrompt(3,plan.map(x=>x.dialogue))));
 assert.throws(()=>clipRequest(job,{...plan[1],dialogue:'khác'}),/không khớp/);
 assert.throws(()=>compileBrandVideoPrompt(3,[first,second]),/không khớp/);
 assert.throws(()=>validateEditedDialogue('',1),/trống/);
 assert.throws(()=>validateEditedDialogue('Xin chào.',1),/ước tính/);
 assert.throws(()=>compileBrandVideoPrompt(1,[first+' {{X}}']),/biến mẫu/);
});
test('the new Muse prompt requests script only, southern Vietnamese speech and explicit overlength consent',()=>{
 const job={schema_version:3,id:'11111111-1111-4111-8111-111111111111',content:'Giới thiệu về Đại Ngân Farm',scene_count:3,scene_seconds:10,allow_summarize:false};
 const marker='PLAN_'+job.id.replaceAll('-','_');
 const prompt=buildStoryboardPrompt(job,marker);
 assert.match(prompt,/CHỈ VIẾT KỊCH BẢN/);
 assert.match(prompt,/miền Nam/);
 assert.match(prompt,/CHƯA đồng ý rút gọn/);
 assert.match(prompt,/status="needs_shortening"/);
 assert.match(prompt,/CÙNG MỘT nhân vật trong CÙNG bối cảnh/);
 assert.doesNotMatch(prompt,/Tạo video gồm \{\{SO_DOAN\}\}/);
 assert.throws(()=>validateStoryboard({id:marker,schema_version:3,status:'needs_shortening',scenes:[]},job),{code:'CONTENT_TOO_LONG',retryable:false});
});
