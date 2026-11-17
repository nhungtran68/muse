import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {MuseAdapter} from './muse-adapter.mjs';
import {installedBrowserExecutable} from './muse-adapter.mjs';

test('Muse uploader keeps five image attachments independent',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'muse-attach-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const files=[];
  for(let index=1;index<=5;index++){
    const file=path.join(dir,`reference-${index}.png`);await writeFile(file,Buffer.from([137,80,78,71,13,10,26,10,index]));files.push(file);
  }
  const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent(`<div data-hatch-composer-chrome><input type="file" accept="image/*" multiple><div id="attachments"></div></div><script>
    document.querySelector('input').addEventListener('change',event=>{
      const target=document.querySelector('#attachments');target.replaceChildren();
      for(const file of event.target.files){const image=document.createElement('img');image.alt=file.name;target.append(image);}
    });</script>`);
  const adapter=new MuseAdapter('',dir);adapter.requirePage=()=>page;
  await adapter.attachReference(files);
  assert.deepEqual(await page.locator('input[type=file]').evaluate(input=>Array.from(input.files,file=>file.name)),files.map(file=>path.basename(file)));
  assert.equal(await page.locator('#attachments img').count(),5);
});
