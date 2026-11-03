import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {processBrandJobV2} from './workflow-v2.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function clip(file,color){
  await new Promise((resolve,reject)=>{
    const p=spawn('ffmpeg',['-y','-v','error','-f','lavfi','-i',`color=c=${color}:s=90x160:r=5:d=5`,'-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',file],{windowsHide:true});
    let err='';p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>code===0?resolve():reject(Error(err)));
  });
}
function fakeClient(jobs,images){
  const scenes=new Map(),objects=new Map(jobs.map((job,i)=>['brand-references/'+job.reference_path,images[i]])),patches=[];
  return {objects,patches,async rpc(name,args){
    patches.push({name,args:structuredClone(args)});
    if(name==='update_brand_job_v2'&&args.p_patch.plan)scenes.set(args.p_id,args.p_patch.plan.map(s=>({scene_index:s.index,status:'waiting'})));
    if(name==='update_brand_scene_v2')Object.assign(scenes.get(args.p_id).find(s=>s.scene_index===args.p_scene),args.p_patch);
    return {data:{},error:null};
  },from(name){assert.equal(name,'brand_scenes');return {select(){return {async eq(_key,id){return {data:structuredClone(scenes.get(id)||[]),error:null};}};}};},storage:{from(bucket){return {
    async download(key){const bytes=objects.get(bucket+'/'+key);return bytes?{data:new Blob([bytes]),error:null}:{error:Error('missing object')};},
    async upload(key,bytes){const full=bucket+'/'+key;if(objects.has(full))return {error:Error('overwrite')};objects.set(full,bytes);return {data:{path:key},error:null};}
  };}}};
}
test('isolates paths, receipts and results for two jobs with different inputs',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v2-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const videos=[path.join(root,'red.mp4'),path.join(root,'blue.mp4')];
  await Promise.all([clip(videos[0],'red'),clip(videos[1],'blue')]);
  const images=[Buffer.alloc(128,1),Buffer.alloc(128,2)];for(const image of images)image.set([137,80,78,71,13,10,26,10]);
  const jobs=images.map((image,i)=>({id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:2,reference_path:`user-${i}/image`,reference_sha256:hash(image),scene_count:1,scene_seconds:5,content:`test job ${i}`,plan:[]}));
  const client=fakeClient(jobs,images),seen=[];
  const muse={async beginJob(job){return {url:`https://muse.ai/chat/${job.id}`};},async storyboard(job){return {analysis:{},outline:job.content,scenes:[{index:1,prompt:job.content,dialogue:'',seconds:5,action:'',source_quotes:[]}]};},async generateSceneV2(job,scene,image,{onBeforeSend}){seen.push([job.id,hash(await readFile(image))]);await onBeforeSend({key:job.id});return {path:videos[jobs.indexOf(job)]};}};
  const auditor={async verify(){return {ok:true};}};
  const results=await Promise.all(jobs.map(job=>processBrandJobV2(job,{client,muse,auditor,workRoot:root,workerId:randomUUID(),leaseToken:randomUUID()})));
  assert.notEqual(results[0],results[1]);
  for(let i=0;i<jobs.length;i++){
    assert.ok(results[i].startsWith(`${jobs[i].user_id}/${jobs[i].id}/${jobs[i].claim_token}/`));
    assert.deepEqual(seen.find(item=>item[0]===jobs[i].id),[jobs[i].id,jobs[i].reference_sha256]);
    assert.ok(client.objects.has('brand-videos/'+results[i]));
  }
  const bad={...jobs[0],claim_token:randomUUID(),reference_sha256:'0'.repeat(64)};
  await assert.rejects(processBrandJobV2(bad,{client,muse,auditor,workRoot:root,workerId:randomUUID(),leaseToken:randomUUID()}),{code:'REFERENCE_MISMATCH'});
});

test('a verified bad scene can be retried using a new generation without resending an uncertain request',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v2-retry-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const video=path.join(root,'test.mp4');await clip(video,'green');
  const image=Buffer.alloc(128,1);image.set([137,80,78,71,13,10,26,10]);
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:2,reference_path:'fixture/image',reference_sha256:hash(image),scene_count:1,scene_seconds:5,content:'Nội dung thử lời thoại',plan:[]};
  const client=fakeClient([job],[image]);
  const muse={async beginJob(){return {url:'https://muse.ai/thread/fixture'};},async storyboard(){return {analysis:{},outline:'Kịch bản thử',scenes:[{index:1,prompt:'Cảnh thử',dialogue:'Xin chào',seconds:5,action:'',source_quotes:[]}]};},async generateSceneV2(_job,scene,_image,{onBeforeSend}){assert.equal(scene.generation,0);await onBeforeSend({key:'fixture'});return {path:video};}};
  await assert.rejects(processBrandJobV2(job,{client,muse,auditor:{async verify(){return {ok:false,reason:'CUT_OFF_SPEECH'};}},workRoot:root,workerId:randomUUID(),leaseToken:randomUUID()}),error=>error.code==='CUT_OFF_SPEECH'&&error.retryable===true);
  const patches=client.patches.filter(p=>p.name==='update_brand_scene_v2').map(p=>p.args.p_patch);
  assert.ok(patches.some(p=>p.submission_state==='sending'&&p.request_receipt?.key==='fixture'));
  assert.ok(patches.some(p=>p.status==='error'&&p.generation===1&&p.submission_state==='not_sent'&&p.request_receipt===null));
  assert.equal(client.objects.size,1);
});
