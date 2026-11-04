import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=4338,api='http://127.0.0.1:4339';
const ids={'one@example.test':'20000000-0000-4000-8000-000000000002','two@example.test':'30000000-0000-4000-8000-000000000003'};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const token=id=>`${encode({alg:'none',typ:'JWT'})}.${encode({sub:id,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})}.test`;
const json=(body,status=200)=>({status,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'},body:JSON.stringify(body)});
test('a member reloads while a job is processing; another member sees only their fixture',async t=>{
 const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'local-test-anon-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 t.after(()=>vite.kill());
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local test site did not start')),30000);vite.stdout.on('data',s=>{if(s.toString().includes('Local:')){clearTimeout(timer);resolve();}});vite.on('exit',code=>reject(Error('Local test site stopped: '+code)));});
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const sessions=[];
 for(const email of Object.keys(ids)){
  const context=await browser.newContext();sessions.push(context);let active=email;
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
   if(url.origin!==api)return route.abort();
   if(request.method()==='OPTIONS')return route.fulfill(json({}));
   if(url.pathname==='/auth/v1/logout')return route.fulfill(json({}));
   if(url.pathname==='/auth/v1/token'){
    active=request.postDataJSON().email;const user={id:ids[active],email:active,aud:'authenticated',role:'authenticated'};
    return route.fulfill(json({access_token:token(user.id),refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user}));
   }
   if(url.pathname==='/rest/v1/profiles')return route.fulfill(json({id:ids[active],email:active,role:'member',approved:true}));
   if(url.pathname==='/rest/v1/app_settings')return route.fulfill(json({id:true,enabled:true,max_scenes:4,daily_limit:30,scene_seconds:10}));
   if(url.pathname==='/rest/v1/video_modes')return route.fulfill(json([{seconds:10}]));
   if(url.pathname==='/rest/v1/brand_jobs'){
    assert.equal(url.searchParams.get('user_id'),`eq.${ids[active]}`);
    return route.fulfill(json([{id:active==='one@example.test'?'aaaaaaaa-0000-4000-8000-000000000001':'bbbbbbbb-0000-4000-8000-000000000001',user_id:ids[active],content:`Nội dung riêng ${active}`,scene_count:2,scene_seconds:10,status:'generating',current_scene:1,created_at:'2026-11-03T00:00:00Z',brand_scenes:[{scene_index:1,status:'done',prompt:'Cảnh mẫu',dialogue:'Lời thoại mẫu',action:'Hành động',planned_seconds:10}]}]));
   }
   return route.fulfill(json({message:'Unexpected local test route'},404));
  });
  const page=await context.newPage();await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#auth-email').fill(email);await page.locator('#auth-password').fill('local-test-password-123');await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#jobs-list').getByText(`Nội dung riêng ${email}`).waitFor({timeout:20000});
  assert.match(await page.locator('#jobs-list').innerText(),/Đang tạo video/);
  await page.reload();await page.locator('#jobs-list').getByText(`Nội dung riêng ${email}`).waitFor({timeout:20000});
  assert.match(await page.locator('#jobs-list').innerText(),/Đang tạo video/);
  const other=Object.keys(ids).find(item=>item!==email);assert.doesNotMatch(await page.locator('#jobs-list').innerText(),new RegExp(other));
 }
 // A history response from the previous login must never enter the new user's DOM.
 const context=sessions[0],page=context.pages()[0];
 let release,seen;
 const delayed=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{seen=resolve;});
 await context.route(api+'/rest/v1/brand_jobs?**',async route=>{
  const url=new URL(route.request().url());
  if(url.searchParams.get('user_id')!==`eq.${ids['one@example.test']}`)return route.fallback();
  seen();await delayed;
  return route.fulfill(json([{id:'aaaaaaaa-0000-4000-8000-000000000001',user_id:ids['one@example.test'],content:'Nội dung riêng one@example.test',scene_count:1,scene_seconds:10,status:'queued',created_at:'2026-11-03T00:00:00Z',brand_scenes:[]}]));
 });
 await page.reload();await started;
 await page.locator('#signout').click();
 await page.locator('#auth-email').fill('two@example.test');await page.locator('#auth-password').fill('local-test-password-123');await page.locator('#auth-form button[type=submit]').click();
 await page.locator('#jobs-list').getByText('Nội dung riêng two@example.test').waitFor({timeout:20000});
 const delivered=page.waitForResponse(response=>response.url().includes('user_id=eq.'+ids['one@example.test']));
 release();await delivered;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.doesNotMatch(await page.locator('#jobs-list').innerText(),/one@example.test/);
 assert.match(await page.locator('#jobs-list').innerText(),/two@example.test/);
});
