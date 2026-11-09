import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import site from '../worker/site.mjs';
import {installedBrowserExecutable} from '../../../worker/muse-adapter.mjs';
import {createServer} from 'node:http';

async function listen(handler){const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,origin:`http://127.0.0.1:${server.address().port}`}}

test('link form passes CSRF checks and prepares a safe PKCE redirect',async t=>{
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage(),origin='https://private.example';let authorizeCalls=0,diagnostics=[];
 const app=await listen((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<h1>Consent page</h1>')});t.after(()=>app.server.close());
 const provider=await listen((_req,res)=>{authorizeCalls++;res.writeHead(303,{location:app.origin+'/oauth/consent?authorization_id=fixture'});res.end()});t.after(()=>provider.server.close());
 page.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text())});page.on('requestfailed',request=>diagnostics.push('requestfailed '+new URL(request.url()).origin));
 const env={DB:{prepare(){}},MR_SITE_ORIGIN:origin,MR_OAUTH_CLIENT_ID:'client',MR_LINK_KEY:Buffer.alloc(32,9).toString('base64url')};
 await context.route('**/*',async route=>{
  const source=route.request(),url=new URL(source.url());
  if(url.origin===origin){
    const headers={...await source.allHeaders(),'oai-authenticated-user-id':'site-user'};
    if(url.pathname==='/link/start')diagnostics.push('origin '+String(headers.origin)+' referrer '+String(headers.referer));
    const req=new Request(source.url(),{method:source.method(),headers,...(['GET','HEAD'].includes(source.method())?{}:{body:source.postDataBuffer()})});
    const response=await site.fetch(req,env);diagnostics.push(url.pathname+' '+response.status);
    const outHeaders=Object.fromEntries(response.headers);
    if(url.pathname==='/'){
      assert.match(outHeaders['content-security-policy'],/form-action[^;]*https:\/\/ai\.ibeetool\.com/);
      outHeaders['content-security-policy']=outHeaders['content-security-policy'].replace('https://wqfzfduccteuycfrymbu.supabase.co',provider.origin).replace('https://ai.ibeetool.com',app.origin);
    }
    if(url.pathname==='/link/start'&&response.status===303){const target=new URL(outHeaders.location);assert.equal(target.origin,'https://wqfzfduccteuycfrymbu.supabase.co');assert.equal(target.searchParams.get('code_challenge_method'),'S256');outHeaders.location=provider.origin+'/authorize';}
    return route.fulfill({status:response.status,headers:outHeaders,body:Buffer.from(await response.arrayBuffer())});
  }
  if(url.origin===provider.origin||url.origin===app.origin)return route.continue();
  return route.abort();
 });
 await page.goto(origin);await page.getByRole('button',{name:'Kết nối tài khoản'}).click();
 try{await page.getByRole('heading',{name:'Consent page'}).waitFor({timeout:10000})}catch(error){throw new Error(`Authorization redirect failed: ${JSON.stringify(diagnostics)} ${await page.locator('body').innerText()}`,{cause:error})}assert.equal(authorizeCalls,1);
});
