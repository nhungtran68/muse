import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverCompletedMedia} from './media-delivery.mjs';

function fixture({enabled=true,group='group-1',claim=true,status='done'}={}){
  const calls=[];
  const client={
    storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://signed.example/result.mp4'},error:null})})},
    from(){return {select(){return this},eq(){return this},single:async()=>({data:{send_outputs_to_zalo:enabled,zalo_group_id:group}})}},
    rpc:async(name,args)=>{calls.push({name,args});if(name==='claim_media_delivery')return {data:claim};return {data:true};}
  };
  return {client,calls};
}

test('disabled admin switch never calls the Zalo bridge',async()=>{
  const f=fixture({enabled:false});
  const result=await deliverCompletedMedia({client:f.client,job:{id:'job-1',storage_provider:'r2'},finalPath:'u/job-1/result.mp4',fetcher:async()=>{throw Error('must not call')}});
  assert.equal(result.status,'disabled');assert.equal(f.calls.length,0);
});

test('completed video is sent once with job id and media URL',async()=>{
  process.env.ZALO_GROUP_WEBHOOK_URL='https://bridge.example/zalo';
  const f=fixture();let request;
  const client={...f.client,auth:{getSession:async()=>({data:{session:{access_token:'token'}}})}};
  const result=await deliverCompletedMedia({client,job:{id:'job-1',storage_provider:'supabase'},finalPath:'u/job-1/result.mp4',origin:'https://example.test',fetcher:async(url,init)=>{request={url,init};return {ok:true,status:200}}});
  assert.equal(result.status,'sent');assert.equal(request.url,process.env.ZALO_GROUP_WEBHOOK_URL);const body=JSON.parse(request.init.body);assert.equal(body.job_id,'job-1');assert.equal(body.target_id,'group-1');assert.match(body.media_url,/supabase|example/);delete process.env.ZALO_GROUP_WEBHOOK_URL;
});

test('in-flight delivery is not duplicated',async()=>{
  process.env.ZALO_GROUP_WEBHOOK_URL='https://bridge.example/zalo';
  const f=fixture({claim:false});const result=await deliverCompletedMedia({client:f.client,job:{id:'job-1',storage_provider:'supabase'},finalPath:'u/job-1/result.mp4',fetcher:async()=>{throw Error('must not call')}});assert.equal(result.status,'duplicate_or_in_flight');delete process.env.ZALO_GROUP_WEBHOOK_URL;
});
