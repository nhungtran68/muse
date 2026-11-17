import test from 'node:test';
import assert from 'node:assert/strict';
import {containImageRect,referenceTileRects,normalizeReferenceImages} from './image-normalization.mjs';

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

test('fits up to four reference images into separate, nonoverlapping tiles',()=>{
  for(const count of [2,3,4]){
    const tiles=referenceTileRects(count);
    assert.equal(tiles.length,count);
    for(const tile of tiles){
      assert.ok(tile.x>=0&&tile.y>=0&&tile.x+tile.width<=720&&tile.y+tile.height<=1280);
      const portrait=containImageRect(900,1600,tile.width,tile.height);
      assert.equal(portrait.width/portrait.height,900/1600);
      for(const other of tiles.filter(item=>item!==tile))assert.ok(tile.x+tile.width<=other.x||other.x+other.width<=tile.x||tile.y+tile.height<=other.y||other.y+other.height<=tile.y);
    }
  }
});

test('rejects more than four images before opening them',async()=>{
  await assert.rejects(normalizeReferenceImages(Array(5).fill({})),/tối đa 4 ảnh/);
});
