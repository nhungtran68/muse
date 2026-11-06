import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaHandler} from '../api/media.mjs';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';

const owner='20000000-0000-4000-8000-000000000002',other='30000000-0000-4000-8000-000000000003';
const jobId='aaaaaaaa-0000-4000-8000-000000000010',claim='bbbbbbbb-0000-4000-8000-000000000001';
const reference=`${owner}/${jobId}/reference`,output=`${owner}/${jobId}/${claim}/result.mp4`;
const future='2030-01-01T00:00:00Z',past='2020-01-01T00:00:00Z';
function setup(){
 const state={job:{id:jobId,user_id:owner,status:'uploading',reference_path:reference,reference_expires_at:null,storage_provider:'r2',reference_storage_provider:'r2',final_path:null,output_expires_at:null,retention_status:'active',brand_scenes:[]},markers:new Map(),objects:new Map(),commands:[],signatures:[],allowExpiry:false};
 const makeClient=(_url,_key,options={})=>{
  const token=options.global?.headers?.Authorization?.replace(/^Bearer /,'');
  const user=token==='owner'?{id:owner}:token==='other'?{id:other}:token==='admin'?{id:'40000000-0000-4000-8000-000000000004'}:null;
  return {auth:{getUser:async()=>user?{data:{user},error:null}:{data:{},error:Error('invalid')}},
   from(){return {select(){return {eq(){return {async maybeSingle(){return {data:user&&(user.id===owner||token==='admin')?structuredClone(state.job):null,error:null};}};}};}};},
   async rpc(name,args){if(name==='can_upload_brand_video')return {data:token==='admin'&&args.p_name===output,error:null};if(name==='register_r2_upload')return {data:!state.rejectTracking,error:null};if(name==='authorize_r2_expiry'||name==='authorize_r2_abandoned_expiry')return {data:state.allowExpiry&&args.p_claim===claim&&args.p_paths.every(p=>p===output),error:null};throw Error(name);},
   storage:{from(bucket){return {async upload(name,data,options){const key=bucket+'/'+name;if(state.markers.has(key))return {error:Error('duplicate')};state.markers.set(key,{data,options});return {error:null};},async download(name){const item=state.markers.get(bucket+'/'+name);return item?{data:new Blob([item.data]),error:null}:{error:Error('missing')};}};}}};
 };
 const s3={async send(command){state.commands.push(command);if(command.constructor.name==='HeadObjectCommand'){const value=state.objects.get(command.input.Key);if(!value)throw Error('missing');return value;}return {};}};
 const sign=async(_client,command,options)=>{state.signatures.push({command,options});return 'https://r2.example/signed';};
 const handler=createMediaHandler({makeClient,s3,sign,storageBucket:'private',projectUrl:'https://example.supabase.co',publicKey:'public',now:()=>Date.parse('2026-11-06T00:00:00Z')});
 async function call(token,body){let status,output;const headers={};const req={method:'POST',headers:token?{authorization:`Bearer ${token}`}:{},body};const res={setHeader(k,v){headers[k]=v;},status(value){status=value;return this;},json(value){output=value;return this;}};await handler(req,res);return {status,output,headers};}
 return {state,call};
}
test('only the owning member can sign the exact reference and bound its size',async()=>{
 const {state,call}=setup(),body={action:'put',jobId,bucket:'brand-references',path:reference,size:42,contentType:'image/png'};
 assert.equal((await call('other',body)).status,404);assert.equal((await call(null,body)).status,401);
 assert.equal((await call('owner',{...body,path:`${owner}/${jobId}/../another`})).status,400);
 assert.equal((await call('owner',{...body,size:10*1024*1024+1})).status,400);
 assert.equal((await call('owner',body)).status,200);
 assert.equal(state.signatures[0].command.input.ContentLength,42);assert.equal(state.signatures[0].command.input.ContentType,'image/png');
 state.rejectTracking=true;assert.equal((await call('owner',body)).status,409);assert.equal(state.signatures.length,1,'never sign an upload that cannot be tracked');
});
test('only the leased admin can upload a result up to 100 MiB',async()=>{
 const {state,call}=setup();state.job.status='generating';
 const body={action:'put',jobId,bucket:'brand-videos',path:output,size:75*1024*1024,contentType:'video/mp4'};
 assert.equal((await call('owner',body)).status,403);assert.equal((await call('admin',body)).status,200);
 assert.equal((await call('admin',{...body,size:100*1024*1024+1})).status,400);
 assert.equal((await call('admin',{...body,path:`${owner}/${jobId}/wrong/result.mp4`})).status,403);
});
test('a real S3 signature binds both upload size and content type',async()=>{
 const s3=new S3Client({region:'auto',endpoint:'https://example.r2.cloudflarestorage.com',forcePathStyle:true,credentials:{accessKeyId:'test',secretAccessKey:'test'},requestChecksumCalculation:'WHEN_REQUIRED'});
 const signed=new URL(await getSignedUrl(s3,new PutObjectCommand({Bucket:'bucket',Key:'key',ContentType:'video/mp4',ContentLength:75*1024*1024}),{expiresIn:600,signableHeaders:new Set(['content-type','content-length'])}));
 assert.equal(signed.searchParams.get('X-Amz-SignedHeaders'),'content-length;content-type;host');
});
test('finalization checks the actual R2 object before creating a zero-byte ownership marker',async()=>{
 const {state,call}=setup(),body={action:'finalize',jobId,bucket:'brand-references',path:reference,size:42,contentType:'image/png'};
 state.objects.set('references/'+reference,{ContentLength:41,ContentType:'image/png'});
 assert.equal((await call('owner',body)).status,409);assert.equal(state.markers.size,0);
 state.objects.set('references/'+reference,{ContentLength:42,ContentType:'image/png'});
 assert.equal((await call('owner',body)).status,200);assert.equal([...state.markers.values()][0].data.length,0);
 assert.equal((await call('owner',body)).status,200,'finalizing after an interrupted response is safe');
});
test('signed reads require the matching finished job and stop at expiry',async()=>{
 const {state,call}=setup(),body={action:'get',jobId,bucket:'brand-videos',path:output};
 assert.equal((await call('owner',body)).status,403);
 state.job.status='done';state.job.final_path=output;state.job.output_expires_at=past;
 assert.equal((await call('owner',body)).status,403);state.job.output_expires_at=future;
 assert.equal((await call('other',body)).status,404);const ok=await call('owner',body);assert.equal(ok.status,200);assert.equal(ok.headers['Cache-Control'],'no-store, private');
 state.job.storage_provider='supabase';assert.equal((await call('owner',body)).status,409);
});
test('download links request an attachment without changing previews or granting another member access',async()=>{
 const {state,call}=setup(),body={action:'get',jobId,bucket:'brand-videos',path:output};
 state.job.status='done';state.job.final_path=output;state.job.output_expires_at=future;
 assert.equal((await call('owner',body)).status,200);
 assert.equal(state.signatures.at(-1).command.input.ResponseContentDisposition,undefined);
 assert.equal((await call('other',{...body,download:true})).status,404);
 assert.equal((await call('owner',{...body,download:true})).status,200);
 assert.equal(state.signatures.at(-1).command.input.ResponseContentDisposition,`attachment; filename="muse-${jobId}.mp4"`);
 assert.equal(state.signatures.at(-1).options.expiresIn,600);
 const scenePath=`${owner}/${jobId}/${claim}/scene-02.mp4`;
 state.job.brand_scenes=[{scene_index:2,status:'done',output_path:scenePath,output_expires_at:future}];
 assert.equal((await call('owner',{...body,path:scenePath,download:true})).status,200);
 assert.equal(state.signatures.at(-1).command.input.ResponseContentDisposition,`attachment; filename="muse-${jobId}-doan-2.mp4"`);
 state.job.output_expires_at=past;
 assert.equal((await call('owner',{...body,download:true})).status,403);
});
test('cleanup only sends deletion to R2 after a valid scoped expired-job claim',async()=>{
 const {state,call}=setup(),body={action:'expire',jobId,claim,bucket:'brand-videos',paths:[output,output]};
 assert.equal((await call(null,body)).status,403);assert.equal(state.commands.length,0);
 state.allowExpiry=true;assert.equal((await call(null,body)).status,200);
 const command=state.commands[0];assert.equal(command.constructor.name,'DeleteObjectCommand');assert.equal(command.input.Key,'outputs/'+output);
 assert.equal((await call(null,{...body,paths:[`another-owner/${output}`]})).status,403);assert.equal(state.commands.length,1);
 assert.equal((await call(null,{...body,action:'expire_abandoned'})).status,200);
});
