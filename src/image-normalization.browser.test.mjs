import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';

test('browser prepares five independent photos without altering the originals',async t=>{
  const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const source=await readFile(new URL('./image-normalization.mjs',import.meta.url),'utf8');
  const results=await page.evaluate(async code=>{
    const {prepareIndependentReferences}=await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(code));
    const colors=['#ff0000','#00ff00','#0000ff','#ffff00','#00ffff'];
    const originals=await Promise.all(colors.map(async(color,index)=>{
      const canvas=document.createElement('canvas');canvas.width=300;canvas.height=300;
      const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,300,300);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      return new File([blob],`original-${index}.png`,{type:'image/png'});
    }));
    const originalSizes=originals.map(file=>file.size),outputs=[];
    for(const result of await prepareIndependentReferences(originals)){
      const bitmap=await createImageBitmap(result.file),canvas=document.createElement('canvas');
      canvas.width=bitmap.width;canvas.height=bitmap.height;
      const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
      const pixel=[...context.getImageData(360,640,1,1).data.slice(0,3)];
      outputs.push({width:bitmap.width,height:bitmap.height,type:result.file.type,pixel});bitmap.close();
    }
    return {outputs,originalsUnchanged:originalSizes.every((size,index)=>originals[index].size===size)};
  },source);
  assert.equal(results.originalsUnchanged,true);
  assert.equal(results.outputs.length,5);
  for(const [index,output] of results.outputs.entries()){
    assert.deepEqual([output.width,output.height,output.type],[720,1280,'image/jpeg']);
    const channel=index===3?0:index===4?1:index;
    assert.ok(output.pixel[channel]>220,`photo ${index+1} remains an individual image`);
  }
});
