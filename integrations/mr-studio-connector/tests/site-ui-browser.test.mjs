import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import site from '../worker/site.mjs';
import {installedBrowserExecutable} from '../../../worker/muse-adapter.mjs';

test('link form passes CSRF checks and prepares a safe PKCE redirect',async t=>{
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage(),origin='https://private.example';let authorizeCalls=0,diagnostics=[];
 page.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text())});page.on('requestfailed',request=>diagnostics.push('requestfailed '+new URL(request.url()).origin));
 const env={DB:{prepare(){}},MR_SITE_ORIGIN:origin,MR_OAUTH_CLIENT_ID:'client',MR_LINK_KEY:Buffer.alloc(32,9).toString('base64url')};
 await context.route('**/*',async route=>{
  const source=route.request(),url=new URL(source.url());
  if(url.origin===origin){
    const headers={...await source.allHeaders(),'oai-authenticated-user-id':'site-user'};
    if(url.pathname==='/link/start')diagnostics.push('origin '+String(headers.origin)+' referrer '+String(headers.referer));
    const req=new Request(source.url(),{method:source.method(),headers,...(['GET','HEAD'].includes(source.method())?{}:{body:source.postDataBuffer()})});
    const response=await site.fetch(req,env);diagnostics.push(url.pathname+' '+response.status);
    if(url.pathname==='/link/start'&&response.status===303){const target=new URL(response.headers.get('location'));assert.equal(target.origin,'https://wqfzfduccteuycfrymbu.supabase.co');assert.equal(target.searchParams.get('code_challenge_method'),'S256');authorizeCalls++;return route.fulfill({status:200,contentType:'text/html',body:'<h1>Redirect prepared</h1>'})}
    return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  }
  return route.abort();
 });
 await page.goto(origin);await page.getByRole('button',{name:'Kết nối tài khoản'}).click();
 try{await page.getByRole('heading',{name:'Redirect prepared'}).waitFor({timeout:10000})}catch(error){throw new Error(`Authorization redirect failed: ${JSON.stringify(diagnostics)} ${await page.locator('body').innerText()}`,{cause:error})}assert.equal(authorizeCalls,1);
});
