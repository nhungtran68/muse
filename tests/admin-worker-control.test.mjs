import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=4371,api='http://127.0.0.1:4372';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const id='10000000-0000-4000-8000-000000000001';
const token=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:id,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})}.test`;
const json=body=>({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'},body:JSON.stringify(body)});

test('only an admin sees the start control, with accurate online and login states on mobile',async t=>{
 const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'test'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 t.after(()=>vite.kill());
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test website did not start')),30000);vite.stdout.on('data',data=>{if(data.toString().includes('Local:')){clearTimeout(timer);resolve();}});vite.on('exit',code=>reject(Error('Test website stopped: '+code)));});
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 let online=true,startCount=0;
 for(const role of ['admin','member']){
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
   if(url.origin!==api)return route.abort();
   if(request.method()==='OPTIONS')return route.fulfill(json({}));
   if(url.pathname==='/auth/v1/token')return route.fulfill(json({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id,email:'test@example.test'}}));
   if(url.pathname==='/rest/v1/profiles')return route.fulfill(json(url.searchParams.has('id')?{id,email:'test@example.test',role,approved:true}:[]));
   if(url.pathname==='/rest/v1/app_settings')return route.fulfill(json({id:true,enabled:true,daily_limit:30}));
   if(url.pathname==='/rest/v1/video_modes')return route.fulfill(json([{seconds:10}]));
   if(url.pathname==='/rest/v1/brand_jobs')return route.fulfill(json([]));
   if(url.pathname==='/rest/v1/rpc/muse_control_status')return route.fulfill(json({paired:true,online,state:'waiting_admin_login'}));
   if(url.pathname==='/rest/v1/rpc/muse_control_start'){startCount++;return route.fulfill(json({accepted:true}));}
   return route.fulfill(json({}));
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#auth-email').fill('test@example.test');await page.locator('#auth-password').fill('test-password-1234');await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#create-form').waitFor();
  if(role==='admin'){
   await page.getByText('Cần đăng nhập quản trị trên máy').waitFor();
   const button=page.locator('#start-system');assert.equal(await button.isEnabled(),true);
   await button.click();await page.getByText('Đã gửi lệnh.',{exact:false}).waitFor();assert.equal(startCount,1);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
   online=false;await page.reload();await page.getByText('Máy chưa kết nối',{exact:true}).waitFor();assert.equal(await page.locator('#start-system').isDisabled(),true);
  }else assert.equal(await page.locator('#start-system').count(),0);
  await context.close();
 }
});
