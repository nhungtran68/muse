import test from 'node:test';
import assert from 'node:assert/strict';
import {containImageRect} from './image-normalization.mjs';

test('contains a landscape image inside the vertical video frame without cropping or distortion',()=>{
  const rect=containImageRect(1920,1080);
  assert.equal(rect.width,720);assert.equal(rect.height,405);assert.equal(rect.x,0);assert.equal(rect.y,437.5);
  assert.equal(rect.width/rect.height,1920/1080);
});

test('keeps an already vertical 9:16 image full-frame',()=>{
  assert.deepEqual(containImageRect(1080,1920),{x:0,y:0,width:720,height:1280});
});

test('rejects invalid image dimensions with a useful validation error',()=>{
  assert.throws(()=>containImageRect(0,1920),/Kích thước ảnh không hợp lệ/);
});
