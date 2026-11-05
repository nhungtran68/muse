import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {MuseAdapter,installedBrowserExecutable} from './muse-adapter.mjs';

const job={id:'59f9bb31-923f-4c71-981c-f7ff69e46866',scene_count:3,scene_seconds:10};
const sceneKey=index=>`Cảnh ${index}/3 của video thương hiệu ${job.id}.`;

async function fixture(t,html){
  const executablePath=installedBrowserExecutable();
  const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const context=await browser.newContext({acceptDownloads:true,offline:true});
  const page=await context.newPage();
  const root=await mkdtemp(path.join(tmpdir(),'muse-worker-regression-'));
  t.after(async()=>{await browser.close();await rm(root,{recursive:true,force:true});});
  const adapter=new MuseAdapter(path.join(root,'profile'),root,{sceneTimeoutMs:6000,pollMs:20,composerTimeoutMs:3000});
  adapter.page=page;
  // This is an isolated local fixture: no Muse account, history, or network requests.
  adapter.requirePage=()=>page;
  await page.setContent(html);
  return {adapter,page,root};
}

test('receives all three scenes when Muse replaces old video cards and the total never increases',async t=>{
  const {adapter,page}=await fixture(t,`<main><div id="history"><button aria-label="Mở video có hoạt ảnh" id="old">old</button></div><div id="messages"></div><textarea aria-label="Nhắn tin"></textarea><script>
    window.submissions=0;
    document.querySelector('textarea').addEventListener('keydown',event=>{
      if(event.key!=='Enter')return;
      event.preventDefault();window.submissions++;
      const text=event.target.value;event.target.value='';
      document.querySelector('#history').replaceChildren();
      const messages=document.querySelector('#messages');messages.replaceChildren();
      const message=document.createElement('p');message.textContent=text;messages.append(message);
      setTimeout(()=>{const result=document.createElement('div');result.setAttribute('role','button');result.setAttribute('tabindex','0');result.setAttribute('aria-label',window.submissions===2?'Mở video':'Open animated video scene.mp4');result.textContent='Generated video '+window.submissions;result.id='video-'+window.submissions;messages.append(result);},50);
    });</script></main>`);
  adapter.attachReference=async()=>{};
  const outputs=[];
  adapter.downloadScene=async id=>{outputs.push(id);return {path:id+'.mp4'};};
  for(let index=1;index<=3;index++)await adapter.generateScene(job,{index,prompt:'Test scene with a different action'},'fixture.png');
  assert.equal(await page.evaluate(()=>window.submissions),3);
  assert.deepEqual(outputs,[1,2,3].map(index=>`${job.id}-${index}`));
  assert.equal(await page.getByRole('button',{name:/video/i}).count(),1);
});

test('ignores old videos and an unsent draft; resumes only the matching submitted scene',async t=>{
  const {adapter,page}=await fixture(t,'<button aria-label="Mở video">old video</button><main><div id="messages"></div><textarea aria-label="Message"></textarea></main>');
  await page.getByRole('textbox').fill(sceneKey(1));
  let response=await adapter.sceneResponse(sceneKey(1));
  assert.equal(response.requested,false);assert.equal(response.video,null);
  await page.getByRole('textbox').fill('');
  await page.locator('#messages').evaluate((element,key)=>{const message=document.createElement('p');message.textContent=key;element.append(message);},sceneKey(1));
  response=await adapter.sceneResponse(sceneKey(1));
  assert.equal(response.requested,true);assert.equal(response.video,null);
  await page.locator('#messages').evaluate(element=>{const button=document.createElement('button');button.setAttribute('aria-label','Mở video');element.append(button);});
  // A result may be ready while Muse is still finishing its response.
  await page.locator('main').evaluate(element=>{const stop=document.createElement('button');stop.setAttribute('aria-label','Stop task');element.append(stop);});
  let attached=0;
  adapter.attachReference=async()=>{attached++;};
  adapter.downloadScene=async()=>({path:'existing-scene.mp4'});
  const output=await adapter.generateScene(job,{index:1},'unused.png',{resumeOnly:true});
  assert.equal(output.path,'existing-scene.mp4');assert.equal(attached,0);
  await assert.rejects(()=>adapter.generateScene(job,{index:2},'unused.png',{resumeOnly:true}),/Không thấy yêu cầu cảnh 2/);
  assert.equal(attached,0);
});

test('waits for the composer to return after preview closes without navigating away',async t=>{
  const {adapter,page}=await fixture(t,`<main><dialog open role="dialog" aria-label="Media preview"><button id="close">Close</button></dialog></main><script>
    const close=()=>{document.querySelector('dialog')?.remove();setTimeout(()=>{const input=document.createElement('textarea');input.setAttribute('aria-label','Message');document.querySelector('main').append(input);},150);};
    document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
    document.querySelector('#close').addEventListener('click',close);
    </script>`);
  const initialUrl=page.url();
  const input=await adapter.cleanComposer();
  assert.equal(await input.isVisible(),true);
  assert.equal(page.url(),initialUrl);
});

test('waits for asynchronous Escape dismissal without racing a disappearing Close button',async t=>{
  const {adapter,page}=await fixture(t,`<style>@keyframes closing {from {transform:translateX(0)} to {transform:translateX(1000px)}}</style><main><dialog open role="dialog" aria-label="Media preview"><button id="close" aria-label="Close">Close</button></dialog></main><script>
    window.closeClicks=0;
    const close=()=>{document.querySelector('dialog')?.remove();const input=document.createElement('textarea');input.setAttribute('aria-label','Message');document.querySelector('main').append(input);};
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){document.querySelector('#close').style.animation='closing 10s linear infinite';setTimeout(close,1000);}});
    document.querySelector('#close').addEventListener('click',()=>{window.closeClicks++;close();});
    </script>`);
  page.setDefaultTimeout(2000);adapter.composerTimeoutMs=5000;
  await adapter.cleanComposer();
  assert.equal(await page.evaluate(()=>window.closeClicks),0);
  assert.equal(await page.getByRole('dialog').count(),0);
});

test('downloads the scene and closes media before waiting for the next composer',async t=>{
  const {adapter,page,root}=await fixture(t,'<main><dialog open role="dialog" aria-label="Media preview"><video></video><button id="download">Download</button></dialog></main>');
  await page.evaluate(()=>{
    const bytes=new Uint8Array(2048);bytes.set([0,0,0,24,102,116,121,112,105,115,111,109]);
    const url=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
    Object.defineProperties(document.querySelector('video'),{duration:{value:10},videoWidth:{value:720},videoHeight:{value:1280}});
    document.querySelector('#download').addEventListener('click',()=>{const link=document.createElement('a');link.href=url;link.download='scene.mp4';link.click();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){document.querySelector('dialog').remove();setTimeout(()=>{const input=document.createElement('textarea');input.setAttribute('aria-label','Message');document.querySelector('main').append(input);},100);}});
  });
  const output=await adapter.downloadScene('fixture-1');
  assert.equal(output.path,path.join(root,'fixture-1.mp4'));
  assert.equal((await readFile(output.path)).length,2048);
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await (await adapter.cleanComposer()).isVisible(),true);
});

test('a saved request prevents a missing conversation from submitting the scene twice',async t=>{
  const {adapter,page,root}=await fixture(t,'<textarea aria-label="Message"></textarea>');
  adapter.sceneTimeoutMs=200;
  adapter.attachReference=async()=>{};
  await assert.rejects(()=>adapter.generateScene(job,{index:1,prompt:'A static local test'},'fixture.png'),/Chưa nhận được MP4/);
  const receiptFile=path.join(root,job.id,'request-1.json');
  const receipt=JSON.parse(await readFile(receiptFile,'utf8'));
  assert.equal(receipt.requestKey,sceneKey(1));
  // A production receipt must target muse.ai. A local receipt is intentionally rejected.
  await assert.rejects(()=>adapter.generateScene(job,{index:1},'unused.png'),/Địa chỉ cuộc chat đã lưu không hợp lệ/);
  assert.ok((await page.getByRole('textbox').inputValue()).startsWith(sceneKey(1)));
  await page.getByRole('textbox').fill('');
  receipt.url='https://muse.ai/chat-test';
  await writeFile(receiptFile,JSON.stringify(receipt));
  page.url=()=>receipt.url;
  await assert.rejects(()=>adapter.generateScene(job,{index:1},'unused.png'),/Không thấy yêu cầu cảnh 1/);
  assert.equal(await page.getByRole('textbox').inputValue(),'');
});

test('stops promptly when Muse disconnects the account, before any scene is sent',async t=>{
  const {adapter}=await fixture(t,'<h1>Đã ngắt kết nối Muse</h1><p>Chúng tôi đã ngắt kết nối Muse để bảo vệ thông tin của bạn.</p>');
  adapter.page.url=()=> 'https://muse.ai/';
  adapter.open=async()=>adapter.page;
  const start=Date.now();
  await assert.rejects(()=>adapter.waitForLogin({timeoutMs:30000}),error=>error.code==='MUSE_DISCONNECTED');
  assert.ok(Date.now()-start<3000);
  await assert.rejects(()=>adapter.cleanComposer(),error=>error.code==='MUSE_DISCONNECTED');
});
