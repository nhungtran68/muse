import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=4395,api='http://127.0.0.1:4396';
const owner='20000000-0000-4000-8000-000000000002';
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const token=`${enc({alg:'none',typ:'JWT'})}.${enc({sub:owner,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})}.test`;
const user={id:owner,email:'member@example.test',aud:'authenticated',role:'authenticated'};
const json=body=>({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'},body:JSON.stringify(body)});

test('OAuth page requires member sign-in and explicit consent',async t=>{
 const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'test-anon-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 t.after(()=>vite.kill());
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Site did not start')),30000);vite.stdout.on('data',chunk=>{if(chunk.toString().includes('Local:')){clearTimeout(timeout);resolve()}});vite.on('exit',code=>reject(Error(`Site stopped: ${code}`)))});
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage();let consentCalls=[];
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
  if(url.origin!==api)return route.abort();
  if(req.method()==='OPTIONS')return route.fulfill(json({}));
  if(url.pathname==='/auth/v1/token')return route.fulfill(json({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user}));
  if(url.pathname==='/auth/v1/user')return route.fulfill(json(user));
  if(url.pathname==='/rest/v1/profiles')return route.fulfill(json({approved:true}));
  if(url.pathname==='/auth/v1/oauth/authorizations/request-id')return route.fulfill(json({authorization_id:'request-id',client:{name:'Mr Studio connector'},user,redirect_uri:'https://connector.test/callback',scope:'openid email'}));
  if(url.pathname==='/auth/v1/oauth/authorizations/request-id/consent'){consentCalls.push(req.postDataJSON());return route.fulfill(json({redirect_url:'https://connector.test/callback?code=test'}))}
  return route.fulfill({status:404,contentType:'application/json',body:'{}'});
 });
 await page.goto(`http://127.0.0.1:${port}/oauth/consent?authorization_id=request-id`);
 await page.locator('#auth-email').fill('member@example.test');await page.locator('#auth-password').fill('example-password-123');await page.locator('#auth-form button[type=submit]').click();
 await page.getByRole('heading',{name:'Cho phép liên kết?'}).waitFor();
 assert.match(await page.locator('body').innerText(),/Mr Studio connector/);assert.equal(consentCalls.length,0);
 await page.getByRole('button',{name:'Cho phép'}).click();
 await page.waitForURL('https://connector.test/callback?code=test',{waitUntil:'commit',timeout:10000}).catch(()=>{});
 assert.equal(consentCalls.length,1);assert.equal(consentCalls[0].action,'approve');
});
