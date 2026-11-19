import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';
import {normalizePhone,phoneLoginEmail,passwordLoginIdentifier} from '../src/phone-auth.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=4350,api='http://127.0.0.1:4351',owner='40000000-0000-4000-8000-000000000004';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const token=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:owner,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})}.test`;
const json=(body,status=200)=>({status,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'},body:JSON.stringify(body)});

test('Vietnamese phone numbers normalize for signup and legacy email remains usable',()=>{
 assert.equal(normalizePhone('0912 345 678'),'+84912345678');
 assert.equal(normalizePhone('84912345678'),'+84912345678');
 assert.equal(normalizePhone('+84 912-345-678'),'+84912345678');
 assert.equal(phoneLoginEmail('0912 345 678'),'84912345678@phone-login.ibeetool.com');
 assert.deepEqual(passwordLoginIdentifier('Admin@Example.test'),{email:'admin@example.test'});
 assert.deepEqual(passwordLoginIdentifier('0912345678'),{email:'84912345678@phone-login.ibeetool.com'});
 assert.throws(()=>normalizePhone('09123'),/Số điện thoại/);
});

test('signup requires matching passwords and creates a pending phone account without email',async t=>{
 process.env.VITE_SUPABASE_URL=api;process.env.VITE_SUPABASE_PUBLISHABLE_KEY='local-test-anon-key';
 const vite=await createServer({root,configFile:false,server:{host:'127.0.0.1',port,strictPort:true}});await vite.listen();t.after(()=>vite.close());
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage();
 const calls=[],loginCalls=[];
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
  if(url.origin!==api)return route.abort();
  if(request.method()==='OPTIONS')return route.fulfill(json({}));
  if(url.pathname==='/auth/v1/signup'){
   const body=request.postDataJSON();calls.push(body);
   return route.fulfill(json({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:owner,phone:null,email:body.email,aud:'authenticated',role:'authenticated'}}));
  }
  if(url.pathname==='/auth/v1/token'){
   const body=request.postDataJSON();loginCalls.push(body);
   return route.fulfill(json({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:owner,phone:null,email:body.email,aud:'authenticated',role:'authenticated'}}));
  }
  if(url.pathname==='/auth/v1/logout')return route.fulfill(json({}));
  if(url.pathname==='/rest/v1/profiles')return route.fulfill(json({id:owner,email:null,phone:'+84912345678',role:'member',approved:false}));
  if(url.pathname==='/rest/v1/app_settings')return route.fulfill(json({id:true,enabled:true,daily_limit:30}));
  if(url.pathname==='/rest/v1/brand_jobs')return route.fulfill(json([]));
  return route.fulfill(json({message:`Unexpected route: ${url.pathname}`},404));
 });
 await page.goto(`http://127.0.0.1:${port}`);
 await page.locator('#switch-auth').click();
 assert.match(await page.locator('.auth-box').innerText(),/không cần xác minh email/);
 await page.locator('#auth-email').fill('0912 345 678');
 await page.locator('#auth-password').fill('password-strong-123');
 await page.locator('#auth-confirm-password').fill('different-strong-123');
 await page.locator('#auth-form button[type=submit]').click();
 assert.equal(calls.length,0);
 assert.match(await page.locator('#notice').innerText(),/chưa khớp/);
 await page.locator('#auth-confirm-password').fill('password-strong-123');
 await page.locator('#auth-form button[type=submit]').click();
 await page.getByText('Tài khoản đang chờ duyệt').waitFor();
 assert.equal(calls.length,1);
 assert.equal(calls[0].email,'84912345678@phone-login.ibeetool.com');
 assert.equal(calls[0].phone,undefined);
 assert.equal(await page.locator('#create-form').count(),0);
 assert.match(await page.locator('.side-bottom').innerText(),/\+84912345678/);
 await page.locator('#signout').click();
 await page.locator('#auth-email').fill('0912 345 678');
 await page.locator('#auth-password').fill('password-strong-123');
 await page.locator('#auth-form button[type=submit]').click();
 await page.getByText('Tài khoản đang chờ duyệt').waitFor();
 assert.equal(loginCalls.length,1);
 assert.equal(loginCalls[0].email,'84912345678@phone-login.ibeetool.com');
 assert.equal(loginCalls[0].phone,undefined);
});
