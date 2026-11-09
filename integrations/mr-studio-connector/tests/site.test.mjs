import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import site from '../worker/site.mjs';

const origin='https://private.example',uid='20000000-0000-4000-8000-000000000002',headers={'oai-authenticated-user-id':'site-user'};
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../migrations/0001_link_sessions.sql',import.meta.url),'utf8'));
 const DB={prepare(text){return{bind(...args){const stmt=sql.prepare(text);return{async run(){return{meta:{changes:stmt.run(...args).changes}}},async first(){return stmt.get(...args)||null}}}}}};
 return {DB,MR_SITE_ORIGIN:origin,MR_OAUTH_CLIENT_ID:'client',MR_LINK_KEY:Buffer.alloc(32,9).toString('base64url')};
}
function rpc(name,args){return new Request(origin+'/mcp',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})}
test('fails closed without gateway identity or complete configuration',async()=>{
 const env=fixture();assert.equal((await site.fetch(new Request(origin),env)).status,401);
 assert.equal((await site.fetch(new Request(origin,{headers}),{})).status,503);
 assert.equal((await site.fetch(new Request('https://other.example/',{headers}),env)).status,400);
});
test('unconfigured Site advertises tools but refuses every action',async()=>{
 const req=(method,params)=>new Request(origin+'/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const list=await (await site.fetch(req('tools/list'),{})).json();assert.ok(list.result.tools.length>0);
 for(const name of ['link_account','prepare_request','list_requests']){
  const call=await (await site.fetch(req('tools/call',{name,arguments:{}}),{})).json();
  assert.equal(call.result.isError,true);assert.match(call.result.content[0].text,/đang được thiết lập/);
 }
});
test('tool discovery is possible without an identity but actions require one',async()=>{
 const env=fixture();const req=(method,params)=>new Request(origin+'/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const list=await (await site.fetch(req('tools/list'),env)).json();assert.ok(list.result.tools.length>0);
 const call=await (await site.fetch(req('tools/call',{name:'link_account',arguments:{}}),env)).json();assert.equal(call.result.isError,true);
});
test('link, authenticated job submission and account isolation work with mocked providers',async t=>{
 const env=fixture(),prior=globalThis.fetch;let calls=[];
 globalThis.fetch=async(input,init)=>{
  const req=new Request(input,init),url=new URL(req.url);calls.push({url:url.pathname,authorization:req.headers.get('authorization')});
  if(url.pathname==='/auth/v1/oauth/token')return Response.json({access_token:'member-token',refresh_token:'refresh-token',expires_in:3600,token_type:'bearer'});
  if(url.pathname==='/auth/v1/user')return Response.json({id:uid,email:'test@example.test'});
  if(url.pathname==='/auth/v1/user/oauth/grants'&&req.method==='DELETE')return new Response(null,{status:204});
  if(url.pathname==='/rest/v1/profiles')return Response.json({approved:true});
  if(url.pathname==='/rest/v1/rpc/submit_single_media_job'){
    const args=await req.json();return Response.json({id:args.p_id,user_id:uid,content:args.p_content,creation_mode:args.p_mode,status:'queued',created_at:'2026-01-01'});
  }
  throw Error('Unexpected request: '+url.pathname);
 };
 t.after(()=>globalThis.fetch=prior);
 const start=await site.fetch(new Request(origin+'/link/start',{method:'POST',headers:{...headers,Origin:origin}}),env);assert.equal(start.status,303);
 const state=new URL(start.headers.get('location')).searchParams.get('state');
 const callback=await site.fetch(new Request(origin+'/link/callback?'+new URLSearchParams({code:'code',state}),{headers}),env);assert.equal(callback.status,303);
 const stored=env.DB.prepare('SELECT envelope FROM link_sessions WHERE user_id=?').bind('site-user');assert.ok(!(await stored.first()).envelope.includes('refresh-token'));
 const prepared=await (await site.fetch(rpc('prepare_request',{}),env)).json();const ids=prepared.result.structuredContent.result;
 const created=await (await site.fetch(rpc('create_request',{...ids,mode:'video_free',content:'Video giới thiệu khu vườn'}),env)).json();assert.equal(created.result.structuredContent.result.status,'queued');
 const unauthorized=await (await site.fetch(rpc('list_requests',{userId:'site-user-2'}),env)).json();assert.equal(unauthorized.error.code,-32602);
 assert.equal(calls.filter(x=>x.url==='/rest/v1/rpc/submit_single_media_job').length,1);
 assert.ok(calls.filter(x=>x.url.startsWith('/rest/v1/')).every(x=>x.authorization==='Bearer member-token'));
 const unlinked=await site.fetch(new Request(origin+'/link/disconnect',{method:'POST',headers:{...headers,Origin:origin}}),env);assert.match(await unlinked.text(),/thu hồi quyền/);
 const after=await (await site.fetch(rpc('list_requests',{}),env)).json();assert.equal(after.result.isError,true);
});
