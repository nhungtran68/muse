import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=4350,api='http://127.0.0.1:4351';
const first='20000000-0000-4000-8000-000000000002',second='30000000-0000-4000-8000-000000000003',jobId='aaaaaaaa-0000-4000-8000-000000000001';
const content='Giơi thiệu về đại ngân farm';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64');
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenExpiry=Math.floor(Date.now()/1000)+3600;
const token=id=>`${encode({alg:'none',typ:'JWT'})}.${encode({sub:id,exp:tokenExpiry,aud:'authenticated',role:'authenticated'})}.test`;
const json=body=>({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'},body:JSON.stringify(body)});

test('content errors restore only the owner input and image; a delayed restore cannot fill another account',async t=>{
 const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'local-test-anon-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 t.after(()=>vite.kill());
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local web did not start')),30000);vite.stdout.on('data',s=>{if(s.toString().includes('Local:')){clearTimeout(timer);resolve();}});vite.on('exit',code=>reject(Error('Local web stopped: '+code)));});
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage();
 let active=first,delay=null,downloadStarted=null,rpcCalls=0;
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
  if(url.origin!==api)return route.abort();
  if(request.method()==='OPTIONS')return route.fulfill(json({}));
  if(url.pathname==='/auth/v1/token'){
   const email=request.postDataJSON().email;active=email==='one@example.test'?first:second;
   return route.fulfill(json({access_token:token(active),refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,user:{id:active,email,aud:'authenticated',role:'authenticated'}}));
  }
  if(url.pathname==='/auth/v1/logout')return route.fulfill(json({}));
  if(url.pathname==='/rest/v1/profiles')return route.fulfill(json({id:active,email:active===first?'one@example.test':'two@example.test',role:'member',approved:true}));
  if(url.pathname==='/rest/v1/app_settings')return route.fulfill(json({id:true,enabled:true,max_scenes:4,daily_limit:30,scene_seconds:10}));
  if(url.pathname==='/rest/v1/video_modes')return route.fulfill(json([{seconds:10}]));
  if(url.pathname==='/rest/v1/brand_jobs'){
   assert.equal(url.searchParams.get('user_id'),`eq.${active}`);
   return route.fulfill(json(active===first?[{id:jobId,user_id:first,content,scene_count:3,scene_seconds:10,status:'error',error_code:'CONTENT_INSUFFICIENT',error:'Kịch bản chưa đầy đủ.',retryable:false,attempt:1,max_attempts:3,reference_path:`${first}/${jobId}/reference`,reference_sha256:createHash('sha256').update(image).digest('hex'),created_at:'2026-11-04T00:00:00Z',brand_scenes:[]}]:[]));
  }
  if(url.pathname.startsWith('/storage/v1/object/')){
   assert.ok(url.pathname.endsWith(`/brand-references/${first}/${jobId}/reference`));
   assert.equal(request.headers().authorization,'Bearer '+token(first));
   downloadStarted?.();if(delay)await delay;
   return route.fulfill({status:200,contentType:'image/png',headers:{'access-control-allow-origin':'*'},body:image});
  }
  if(url.pathname.startsWith('/rest/v1/rpc/'))rpcCalls++;
  return route.fulfill({...json({message:'Unexpected test route'}),status:404});
 });
 async function login(email){await page.locator('#auth-email').fill(email);await page.locator('#auth-password').fill('local-test-password-123');await page.locator('#auth-form button[type=submit]').click();await page.locator('#create-form').waitFor({timeout:20000});}
 await page.goto(`http://127.0.0.1:${port}`);await login('one@example.test');
 await page.locator('.edit-input').waitFor();assert.equal(await page.locator('.retry-job').count(),0);
 await page.locator('#scene-count').selectOption('1');await page.locator('.edit-input').click();
 await page.waitForFunction(()=>document.querySelector('#reference').files.length===1);
 assert.equal(await page.locator('#content').inputValue(),content);
 assert.equal(await page.locator('#scene-count').inputValue(),'3');
 assert.match(await page.locator('#content-guidance').innerText(),/phát triển ý tưởng ngắn/);
 const restored=await page.locator('#reference').evaluate(async el=>Array.from(new Uint8Array(await el.files[0].arrayBuffer())));
 assert.deepEqual(Buffer.from(restored),image);
 let release;delay=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{downloadStarted=resolve;});
 await page.locator('.edit-input').click();await started;
 await page.locator('#signout').click();await login('two@example.test');
 const delivered=page.waitForResponse(response=>response.url().includes('/storage/v1/object/'));
 release();await delivered;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.locator('#content').inputValue(),'');
 assert.equal(await page.locator('#reference').evaluate(el=>el.files.length),0);
 assert.doesNotMatch(await page.locator('#jobs-list').innerText(),/đại ngân farm/i);
 assert.equal(rpcCalls,0,'Editing input must never submit a new job or retry automatically');
});
