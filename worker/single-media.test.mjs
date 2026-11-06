import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {processSingleMediaJob} from './single-media.mjs';
import {buildFlexibleMediaPrompt} from '../shared/creation-modes.mjs';

function fixture(mode){
 const job={id:randomUUID(),user_id:randomUUID(),schema_version:2,creation_mode:mode,scene_count:1,scene_seconds:null,claim_token:randomUUID(),reference_path:null,plan:[{index:1,prompt:'Yêu cầu gốc 30 giây, không thay nội dung.',action:mode==='image'?'single_image_request':'single_free_video_request'}]};
 const calls=[],objects=new Map(),scene={scene_index:1,action:job.plan[0].action,generation:0};
 const client={async rpc(name,args){calls.push({name,args});if(name==='update_brand_scene_v2')Object.assign(scene,args.p_patch);return {data:{},error:null};},
  from(){return {select(){return {eq:async()=>({data:[scene],error:null})};}};},storage:{from(bucket){assert.equal(bucket,'brand-videos');return {async upload(key,data,options){objects.set(key,{data,options});return {error:null};}};}}};
 return {job,client,calls,objects,scene};
}
async function mediaFile(root,kind){
 const file=path.join(root,kind==='image'?'source.png':'source.mp4');
 const args=['-y','-v','error','-f','lavfi','-i',kind==='image'?'color=c=blue:s=320x180':'color=c=blue:s=320x180:r=2:d=30'];
 args.push(...(kind==='image'?['-frames:v','1']:['-c:v','libx264','-pix_fmt','yuv420p']),file);
 await new Promise((resolve,reject)=>{const child=spawn('ffmpeg',args,{windowsHide:true});let err='';child.stderr.on('data',part=>err+=part);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(err)));});return file;
}
for(const mode of ['video_free','image'])test(`${mode} stores one real output, with no storyboard, split, or forced 10-second duration`,async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'muse-media-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const kind=mode==='image'?'image':'video',file=await mediaFile(root,kind),{job,client,calls,objects}=fixture(mode);let sends=0;
 const muse={beginJob:async()=>({url:'https://muse.ai/thread/'+randomUUID()}),async generateSceneV2(seen,scene,image,callbacks){sends++;assert.equal(seen.id,job.id);assert.equal(scene.prompt,job.plan[0].prompt);assert.equal(image,null);await callbacks.onBeforeSend({key:'saved-receipt'});await callbacks.onSubmitted();return {path:file};}};
 const result=await processSingleMediaJob(job,{client,muse,workRoot:root,workerId:randomUUID(),leaseToken:randomUUID()});
 assert.equal(sends,1);assert.equal(objects.size,1);assert.ok(result.startsWith(`${job.user_id}/${job.id}/${job.claim_token}/`));
 const complete=calls.find(call=>call.name==='complete_single_media_job');assert.equal(complete.args.p_path,result);assert.equal(complete.args.p_probe.kind,kind);assert.equal(complete.args.p_probe.width,320);assert.equal(complete.args.p_probe.height,180);
 assert.equal(complete.args.p_probe.duration,kind==='image'?null:30);
 assert.equal(objects.get(result).options.contentType,kind==='image'?'image/png':'video/mp4');assert.deepEqual(objects.get(result).data,await readFile(file));
 const prompt=buildFlexibleMediaPrompt(job,job.plan[0],'KEY');assert.ok(prompt.includes(job.plan[0].prompt));assert.ok(!prompt.includes('dài 10 giây'));
});
test('a timed-out free request retains its receipt and never completes or uploads a result',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'muse-media-timeout-'));t.after(()=>rm(root,{recursive:true,force:true}));const {job,client,calls,objects,scene}=fixture('video_free');
 scene.request_receipt={key:'original-request'};
 const muse={beginJob:async()=>({url:'https://muse.ai/thread/'+randomUUID()}),async generateSceneV2(_j,_s,_i,{receipt}){assert.equal(receipt.key,'original-request');throw Object.assign(Error('Still rendering'),{code:'MUSE_TIMEOUT',retryable:true});}};
 await assert.rejects(processSingleMediaJob(job,{client,muse,workRoot:root,workerId:randomUUID(),leaseToken:randomUUID()}),{code:'MUSE_TIMEOUT'});
 assert.equal(scene.request_receipt.key,'original-request');assert.equal(scene.status,'error');assert.equal(objects.size,0);assert.equal(calls.some(call=>call.name==='complete_single_media_job'),false);
});
