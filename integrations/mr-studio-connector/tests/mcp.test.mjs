import test from 'node:test';
import assert from 'node:assert/strict';
import {createMcpHandler} from '../worker/mcp.mjs';

const uid='20000000-0000-4000-8000-000000000002',id='aaaaaaaa-0000-4000-8000-000000000010',key='bbbbbbbb-0000-4000-8000-000000000010';
const request=(method,params)=>new Request('https://connector.test/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
function fixture(){
  let job={id,user_id:uid,status:'queued',content:'Một video về vườn nho',creation_mode:'video_free'};let calls=0;
  const client={auth:{getUser:async()=>({data:{user:{id:uid}}})},rpc:async()=>{calls++;return {data:job}},from:()=>{let where={};const q={select(){return q},eq(k,v){where[k]=v;return q},order(){return q},limit:async()=>({data:where.user_id===job.user_id?[job]:[]}),maybeSingle:async()=>({data:where.user_id===job.user_id&&where.id===job.id?job:null})};return q}};
  let ids=[id,key]; const handler=createMcpHandler({resolveMember:async()=>({client,accessToken:'fixture',mediaGateway:async()=>''}),randomUUID:()=>ids.shift()});
  return {handler,calls:()=>calls,setJob:value=>job={...job,...value}};
}
test('discovery describes scoped tools and prepare never submits',async()=>{const f=fixture();let list=await (await f.handler(request('tools/list'))).json();assert.ok(list.result.tools.some(x=>x.name==='create_request'&&!x.annotations.readOnlyHint));let p=await (await f.handler(request('tools/call',{name:'prepare_request',arguments:{}}))).json();assert.deepEqual(p.result.structuredContent.result,{jobId:id,requestId:key});assert.equal(f.calls(),0)});
test('create invokes the established queue once',async()=>{const f=fixture();const r=await (await f.handler(request('tools/call',{name:'create_request',arguments:{jobId:id,requestId:key,content:'Một video về vườn nho',mode:'video_free'}}))).json();assert.equal(r.result.structuredContent.result.id,id);assert.equal(f.calls(),1)});
test('callers cannot supply credentials or select another member',async()=>{const f=fixture();const r=await (await f.handler(request('tools/call',{name:'get_status',arguments:{jobId:id,userId:uid,accessToken:'not-allowed'}}))).json();assert.equal(r.error.code,-32602);assert.equal(f.calls(),0)});
test('unlinked visitors cannot call tools',async()=>{const h=createMcpHandler({resolveMember:async()=>null});const r=await (await h(request('tools/call',{name:'list_requests',arguments:{}}))).json();assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/liên kết/)});
test('another member job stays inaccessible',async()=>{const f=fixture();f.setJob({user_id:'30000000-0000-4000-8000-000000000003'});const r=await (await f.handler(request('tools/call',{name:'get_status',arguments:{jobId:id}}))).json();assert.equal(r.result.isError,true);assert.equal(r.result.structuredContent,undefined)});
test('malformed calls return protocol error without invoking backend',async()=>{const f=fixture();const r=await (await f.handler(request('tools/call',{name:'create_request',arguments:{mode:'image'}}))).json();assert.equal(r.error.code,-32602);assert.equal(f.calls(),0)});
test('protocol notifications return no body and initialization advertises only the supported version',async()=>{const f=fixture();const init=await (await f.handler(request('initialize',{protocolVersion:'unsupported'}))).json();assert.equal(init.result.protocolVersion,'2026-07-28');const n=await f.handler(new Request('https://connector.test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})}));assert.equal(n.status,202);assert.equal(await n.text(),'')});
test('oversized requests are rejected before backend execution',async()=>{const f=fixture();const r=await f.handler(new Request('https://connector.test/mcp',{method:'POST',body:'x'.repeat(32769)}));assert.equal(r.status,413);assert.equal(f.calls(),0)});
