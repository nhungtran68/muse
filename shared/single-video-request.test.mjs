import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSingleVideoPrompt,createSingleVideoScene,isSingleVideoScene} from './single-video-request.mjs';

test('a single request produces exactly one scene with the selected supported duration',()=>{
  const scene=createSingleVideoScene('Giới thiệu vườn trái cây qua hình ảnh và lời kể gần gũi.',10);
  assert.equal(scene.index,1);
  assert.equal(scene.seconds,10);
  assert.equal(scene.dialogue,'');
  assert.equal(isSingleVideoScene(scene),true);
  assert.throws(()=>createSingleVideoScene('Nội dung đủ dài nhưng sai mode.',7),/thời lượng/);
});

test('video prompt keeps one complete request and the original customer content',()=>{
  const prompt=buildSingleVideoPrompt({scene_seconds:8},{prompt:'Một đoạn phim về khu vườn vào buổi sớm.'},'JOB_123');
  assert.match(prompt,/JOB_123/);
  assert.match(prompt,/đúng một video dài 8 giây/);
  assert.match(prompt,/không chia thành nhiều video/);
  assert.ok(prompt.includes('Một đoạn phim về khu vườn vào buổi sớm.'));
  assert.equal((prompt.match(/MỘT yêu cầu tạo video hoàn chỉnh/g)||[]).length,1);
});
