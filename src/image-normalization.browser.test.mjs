import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';

test('browser combines two and four selected photos without altering the originals',async t=>{
  const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const source=await readFile(new URL('./image-normalization.mjs',import.meta.url),'utf8');
  const results=await page.evaluate(async code=>{
    const {normalizeReferenceImages,referenceTileRects}=await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(code));
    const colors=['#ff0000','#00ff00','#0000ff','#ffff00'];
    const originals=await Promise.all(colors.map(async(color,index)=>{
      const canvas=document.createElement('canvas');canvas.width=300;canvas.height=300;
      const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,300,300);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      return new File([blob],`original-${index}.png`,{type:'image/png'});
    }));
    const originalSizes=originals.map(file=>file.size),outputs=[];
    for(const count of [2,4]){
      const result=await normalizeReferenceImages(originals.slice(0,count));
      const bitmap=await createImageBitmap(result.file),canvas=document.createElement('canvas');
      canvas.width=bitmap.width;canvas.height=bitmap.height;
      const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
      const pixels=referenceTileRects(count).map(tile=>{
        const value=context.getImageData(Math.round(tile.x+tile.width/2),Math.round(tile.y+tile.height/2),1,1).data;
        return [...value.slice(0,3)];
      });
      outputs.push({count,width:bitmap.width,height:bitmap.height,type:result.file.type,pixels});bitmap.close();
    }
    return {outputs,originalsUnchanged:originalSizes.every((size,index)=>originals[index].size===size)};
  },source);
  assert.equal(results.originalsUnchanged,true);
  for(const output of results.outputs){
    assert.deepEqual([output.width,output.height,output.type],[720,1280,'image/jpeg']);
    assert.equal(output.pixels.length,output.count);
    for(let index=0;index<output.count;index++){
      const channel=index===3?0:index;
      assert.ok(output.pixels[index][channel]>220,`photo ${index+1} is visible in its own tile`);
    }
  }
});
