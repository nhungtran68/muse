import test from 'node:test';
import assert from 'node:assert/strict';
import {createMrStudioTools} from '../worker/core.mjs';
const uid='20000000-0000-4000-8000-000000000002', id='aaaaaaaa-0000-4000-8000-000000000010', key='bbbbbbbb-0000-4000-8000-000000000010';
function fixture(){
 let job={id,user_id:uid,content:'Nội dung thử tạo video',creation_mode:'video_free',status:'queued',created_at:'2026-01-01',retryable:true};let calls=[];
 const client={auth:{getUser:async()=>({data:{user:{id:uid}}})},rpc:async(name,args)=>{calls.push([name,args]);return {data:job}},
 from:()=>{let fields={};const q={select(){return q},eq(k,v){fields[k]=v;return q},order(){return q},limit:async()=>({data:fields.user_id===job.user_id?[job]:[]}),maybeSingle:async()=>({data:fields.user_id===job.user_id&&fields.id===job.id?job:null})};return q},
 storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://example.test/signed'}})})}};
 return {client,calls,setJob:v=>job={...job,...v},tools:createMrStudioTools({client,accessToken:'test-token',mediaGateway:async()=> 'https://example.test/r2'})};
}
test('creates one job with a stable idempotency key',async()=>{const f=fixture();let j=await f.tools.create({content:'Nội dung thử tạo video',mode:'video_free',jobId:id,requestId:key});assert.equal(j.id,id);assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].p_request_key,key);assert.equal(f.calls[0][1].p_reference_sha256,null)});
test('denies unsupported 10-second mode and missing idempotency identifiers',async()=>{const f=fixture();await assert.rejects(f.tools.create({content:'Nội dung thử tạo video',mode:'video_10s',jobId:id,requestId:key}));await assert.rejects(f.tools.create({content:'Nội dung thử tạo video',mode:'image',jobId:id}));assert.equal(f.calls.length,0)});
test('history and signed results remain limited to authenticated owner',async()=>{const f=fixture();assert.equal((await f.tools.list()).length,1);f.setJob({user_id:'30000000-0000-4000-8000-000000000003'});await assert.rejects(f.tools.status({jobId:id}),/Không tìm thấy/);await assert.rejects(f.tools.result({jobId:id}),/Không tìm thấy/)});
test('results only available for finished, unexpired outputs',async()=>{const f=fixture();await assert.rejects(f.tools.result({jobId:id}),/chưa sẵn sàng/);f.setJob({status:'done',storage_provider:'r2',final_path:`${uid}/${id}/result.mp4`,retention_status:'active',output_expires_at:'2999-01-01T00:00:00Z'});assert.equal((await f.tools.result({jobId:id})).url,'https://example.test/r2');f.setJob({output_expires_at:'2000-01-01T00:00:00Z'});await assert.rejects(f.tools.result({jobId:id}),/hết hạn/)});
test('authentication failures cannot reach queue',async()=>{const f=fixture();f.client.auth.getUser=async()=>({error:Error('expired')});await assert.rejects(f.tools.create({content:'Nội dung thử tạo video',mode:'image',jobId:id,requestId:key}),/hết hạn/);assert.equal(f.calls.length,0)});
test('output paths must belong to the same user and job',async()=>{const f=fixture();f.setJob({status:'done',storage_provider:'r2',final_path:`${uid}/other-job/result.mp4`,retention_status:'active',output_expires_at:'2999-01-01T00:00:00Z'});await assert.rejects(f.tools.result({jobId:id}),/không hợp lệ/);f.setJob({final_path:`${uid}/${id}/../other.mp4`});await assert.rejects(f.tools.result({jobId:id}),/không hợp lệ/)});
