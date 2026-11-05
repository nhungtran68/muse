import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {failBrandJobV2,processBrandJobV2,processBrandScriptV3} from './workflow-v2.mjs';
import {probeVideo} from './ffmpeg.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('a failed video remains manually retryable after an earlier worker attempt limit',async()=>{
  let patch;
  await failBrandJobV2({id:'job',claim_token:'claim',attempt:5,max_attempts:3},
    Object.assign(Error('Muse timed out'),{code:'MUSE_TIMEOUT',retryable:true}),
    {client:{async rpc(_name,args){patch=args.p_patch;return {data:{id:'job'},error:null};}},workerId:'worker',leaseToken:'lease'});
  assert.equal(patch.status,'error');assert.equal(patch.retryable,true);assert.equal(patch.error_code,'MUSE_TIMEOUT');
});

test('an unlocated saved submission is shown as failed while its receipt remains resumable',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v3-resume-receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const image=Buffer.alloc(128,4);image.set([137,80,78,71,13,10,26,10]);
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,workflow_phase:'video',status:'generating',
    reference_path:'owner/reference',reference_sha256:hash(image),scene_count:1,scene_seconds:10,
    plan:[{index:1,seconds:10,dialogue:'Đây là lời thoại đã được khách hàng duyệt.'}]};
  const receipt={key:'saved-key',url:'https://muse.ai/thread/12345678-1234-1234-1234-123456789abc'};
  const scenes=new Map([[job.id,[{scene_index:1,status:'generating',generation:0,submission_state:'sending',request_receipt:receipt}]]]);
  const client=fakeClient([job],[image],scenes);
  const muse={async beginJob(){return {url:receipt.url};},async generateSceneV2(_job,_scene,_image,{receipt:seen}){
    assert.deepEqual(seen,receipt);
    throw Object.assign(Error('Không tìm thấy yêu cầu cảnh 1 đã gửi; có thể tiếp tục kiểm tra biên nhận cũ, không gửi lại.'),{code:'SUBMISSION_NOT_FOUND',retryable:true});
  }};
  await assert.rejects(processBrandJobV2(job,{client,muse,workRoot:root,workerId:randomUUID(),leaseToken:randomUUID()}),{code:'SUBMISSION_NOT_FOUND'});
  const failed=client.sceneData.get(job.id)[0];
  assert.equal(failed.status,'error');
  assert.equal(failed.error_code,'SUBMISSION_NOT_FOUND');
  assert.deepEqual(failed.request_receipt,receipt);
  assert.equal(failed.output_path,undefined);
});

async function clip(file,color,seconds=5,size='90x160'){
  await new Promise((resolve,reject)=>{
    const p=spawn('ffmpeg',['-y','-v','error','-f','lavfi','-i',`color=c=${color}:s=${size}:r=5:d=${seconds}`,'-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',file],{windowsHide:true});
    let err='';p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>code===0?resolve():reject(Error(err)));
  });
}
function fakeClient(jobs,images,initialScenes=new Map()){
  const scenes=structuredClone(initialScenes),objects=new Map(jobs.map((job,i)=>['brand-references/'+job.reference_path,images[i]])),patches=[];
  return {objects,patches,sceneData:scenes,async rpc(name,args){
    patches.push({name,args:structuredClone(args)});
    if(name==='update_brand_job_v2'&&args.p_patch.plan)scenes.set(args.p_id,args.p_patch.plan.map(s=>({scene_index:s.index,status:'waiting'})));
    if(name==='update_brand_scene_v2')Object.assign(scenes.get(args.p_id).find(s=>s.scene_index===args.p_scene),args.p_patch);
    return {data:{},error:null};
  },from(name){assert.equal(name,'brand_scenes');return {select(){return {async eq(_key,id){return {data:structuredClone(scenes.get(id)||[]),error:null};}};}};},storage:{from(bucket){return {
    async download(key){const bytes=objects.get(bucket+'/'+key);return bytes?{data:new Blob([bytes]),error:null}:{error:Error('missing object')};},
    async upload(key,bytes){const full=bucket+'/'+key;if(objects.has(full))return {error:Error('overwrite')};objects.set(full,bytes);return {data:{path:key},error:null};}
  };}}};
}
test('script phase ends with a saved review draft and never requests a video',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v3-script-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const image=Buffer.alloc(128,1);image.set([137,80,78,71,13,10,26,10]);
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,
    workflow_phase:'script',status:'planning',reference_path:'owner/reference',reference_sha256:hash(image),scene_count:2,scene_seconds:10};
  const client=fakeClient([job],[image]);
  const draft=[1,2].map(index=>({index,seconds:10,dialogue:`Lời thoại đoạn ${index}`,prompt:'Same face and room'}));
  const muse={async beginJob(){return {url:'https://muse.ai/thread/fixture'};},
    async storyboard(_job,path){assert.equal(hash(await readFile(path)),job.reference_sha256);return {analysis:{topic:'fixture'},outline:'Two sections',scenes:draft};},
    async generateSceneV2(){assert.fail('Video generation requires customer approval');}};
  await processBrandScriptV3(job,{client,muse,workRoot:root,workerId:randomUUID(),leaseToken:randomUUID()});
  const completion=client.patches.find(p=>p.name==='complete_brand_script_v3');
  assert.deepEqual(completion.args.p_plan,draft);
  assert.equal(client.patches.some(p=>p.name==='update_brand_scene_v2'),false);
  assert.equal([...client.objects.keys()].some(key=>key.startsWith('brand-videos/')),false);
});
test('malformed approved script never reads the reference or calls Muse',async()=>{
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,
    workflow_phase:'video',status:'generating',reference_path:'owner/reference',reference_sha256:'0'.repeat(64),
    scene_count:2,scene_seconds:10,plan:[{index:1,seconds:10,dialogue:'Đoạn đầu'}]};
  const client={storage:{from(){assert.fail('Must reject before reading image');}},rpc(){assert.fail('Must reject before database mutation');}};
  const muse={beginJob(){assert.fail('Must reject before opening Muse');},generateSceneV2(){assert.fail('Must reject before video generation');}};
  await assert.rejects(processBrandJobV2(job,{client,muse,workRoot:'unused',workerId:randomUUID(),leaseToken:randomUUID()}),
    error=>error.code==='INVALID_APPROVED_SCRIPT'&&error.retryable===false);
});
test('approved three-segment script creates clips in order without asking Muse to rewrite dialogue',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v3-video-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const videos=[1,2,3].map(i=>path.join(root,`segment-${i}.mp4`));
  await Promise.all(videos.map((file,i)=>clip(file,['red','blue','green'][i],10)));
  const image=Buffer.alloc(128,2);image.set([137,80,78,71,13,10,26,10]);
  const plan=[1,2,3].map(index=>({index,seconds:10,dialogue:`Lời khách đã duyệt cho đoạn ${index}, và chỉ đúng phần này được gửi để tạo video.`}));
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,
    workflow_phase:'video',status:'generating',reference_path:'owner/reference',reference_sha256:hash(image),
    scene_count:3,scene_seconds:10,video_prompt_version:'brand-video-10s-v1',plan};
  const scenes=new Map([[job.id,plan.map(s=>({scene_index:s.index,status:'waiting',generation:0,request_receipt:null}))]]);
  const client=fakeClient([job],[image],scenes),received=[];
  const muse={async beginJob(){return {url:'https://muse.ai/thread/approved'};},
    async storyboard(){assert.fail('Approval froze the script; Muse must not write it again');},
    async generateSceneV2(_job,scene,path,{onBeforeSend}){
      assert.equal(hash(await readFile(path)),job.reference_sha256);
      assert.equal(scene.dialogue,plan[scene.index-1].dialogue);
      received.push(scene.index);await onBeforeSend({key:`fixture-${scene.index}`});
      return {path:videos[scene.index-1]};
    }};
  const result=await processBrandJobV2(job,{client,muse,auditor:{async verify(){return {ok:true};}},workRoot:root,workerId:randomUUID(),leaseToken:randomUUID()});
  assert.deepEqual(received,[1,2,3]);
  assert.ok(result.startsWith(`${job.user_id}/${job.id}/${job.claim_token}/`));
  assert.equal(client.patches.filter(p=>p.name==='update_brand_scene_v2'&&p.args.p_patch.status==='done').length,3);
  assert.ok(client.objects.has('brand-videos/'+result));
});

test('four, five and six verified ten-second clips join in exact order and duration',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v3-counts-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const colors=['red','blue','green','yellow','purple','orange'];
  const videos=colors.map((_,i)=>path.join(root,`part-${i+1}.mp4`));
  await Promise.all(videos.map((file,i)=>clip(file,colors[i],10)));
  for(const count of [4,5,6]){
    const image=Buffer.alloc(128,count);image.set([137,80,78,71,13,10,26,10]);
    const plan=Array.from({length:count},(_,i)=>({index:i+1,seconds:10,dialogue:`Lời đã duyệt cho đoạn ${i+1}.`}));
    const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,
      workflow_phase:'video',status:'generating',reference_path:'owner/reference',reference_sha256:hash(image),
      scene_count:count,scene_seconds:10,video_prompt_version:'brand-video-10s-v1',plan};
    const scenes=new Map([[job.id,plan.map(s=>({scene_index:s.index,status:'waiting',generation:0,request_receipt:null}))]]);
    const client=fakeClient([job],[image],scenes),seen=[];
    const muse={async beginJob(){return {url:'https://muse.ai/thread/test'};},
      async generateSceneV2(_job,scene,_image,{onBeforeSend}){
        seen.push(scene.index);await onBeforeSend({key:`scene-${scene.index}`});return {path:videos[scene.index-1]};
      }};
    const finalPath=await processBrandJobV2(job,{client,muse,auditor:{async verify(){return {ok:true};}},
      workRoot:root,workerId:randomUUID(),leaseToken:randomUUID(),retryDelayMs:0});
    assert.deepEqual(seen,Array.from({length:count},(_,i)=>i+1));
    assert.equal(client.patches.filter(p=>p.name==='update_brand_scene_v2'&&p.args.p_patch.status==='done').length,count);
    assert.ok(client.objects.has('brand-videos/'+finalPath));
    const joined=path.join(root,job.id,job.claim_token,'final.mp4');
    assert.ok(Math.abs((await probeVideo(joined)).duration-count*10)<.7);
    const manifest=await readFile(path.join(root,job.id,job.claim_token,'concat.txt'),'utf8');
    assert.deepEqual(manifest.trim().split('\n').map(line=>line.match(/part-(\d+)\.mp4/)[1]),seen.map(String));
  }
});

test('scene two can fail three times and resume alone while scenes one and three stay ordered',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v3-resume-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const videos=[1,2,3].map(i=>path.join(root,`part-${i}.mp4`));
  await Promise.all(videos.map((file,i)=>clip(file,['red','blue','green'][i],10)));
  const image=Buffer.alloc(128,9);image.set([137,80,78,71,13,10,26,10]);
  const plan=[1,2,3].map(index=>({index,seconds:10,dialogue:`Lời duyệt đoạn ${index}.`}));
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,
    workflow_phase:'video',status:'generating',reference_path:'owner/reference',reference_sha256:hash(image),
    scene_count:3,scene_seconds:10,video_prompt_version:'brand-video-10s-v1',plan};
  const scenes=new Map([[job.id,plan.map(s=>({scene_index:s.index,status:'waiting',generation:0,request_receipt:null}))]]);
  const client=fakeClient([job],[image],scenes),calls=[];
  const muse={async beginJob(){return {url:'https://muse.ai/thread/test'};},
    async generateSceneV2(_job,scene,_image,{onBeforeSend}){
      calls.push([scene.index,scene.generation]);await onBeforeSend({key:`scene-${scene.index}-gen-${scene.generation}`});
      if(scene.index===2&&scene.generation<3)throw Object.assign(Error('Muse refused clip'),{code:'MUSE_OUTPUT_REJECTED',retryable:false});
      return {path:videos[scene.index-1]};
    }};
  const context={client,muse,auditor:{async verify(){return {ok:true};}},workRoot:root,workerId:randomUUID(),leaseToken:randomUUID(),retryDelayMs:0};
  await assert.rejects(processBrandJobV2(job,context),{code:'MUSE_OUTPUT_REJECTED'});
  const stored=client.sceneData.get(job.id);
  assert.equal(stored[0].status,'done');assert.equal(stored[1].status,'error');assert.equal(stored[2].status,'waiting');
  assert.equal(stored[1].generation,2);
  // Equivalent to the owner-only retry_brand_scene_v3 transition.
  Object.assign(stored[1],{status:'waiting',generation:3,request_receipt:null,submission_state:'not_sent',error:null,error_code:null});
  const resumed={...job,claim_token:randomUUID()};
  const finalPath=await processBrandJobV2(resumed,context);
  assert.deepEqual(calls,[[1,0],[2,0],[2,1],[2,2],[2,3],[3,0]]);
  assert.ok(client.objects.has('brand-videos/'+finalPath));
  assert.ok(Math.abs((await probeVideo(path.join(root,job.id,resumed.claim_token,'final.mp4'))).duration-30)<.7);
});
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

test('a verified bad scene is automatically retried without resending the old request',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v2-retry-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const video=path.join(root,'test.mp4');await clip(video,'green');
  const image=Buffer.alloc(128,1);image.set([137,80,78,71,13,10,26,10]);
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:2,reference_path:'fixture/image',reference_sha256:hash(image),scene_count:1,scene_seconds:5,content:'Nội dung thử lời thoại',plan:[]};
  const client=fakeClient([job],[image]);
  const generations=[];
  const muse={async beginJob(){return {url:'https://muse.ai/thread/fixture'};},async storyboard(){return {analysis:{},outline:'Kịch bản thử',scenes:[{index:1,prompt:'Cảnh thử',dialogue:'Xin chào',seconds:5,action:'',source_quotes:[]}]};},async generateSceneV2(_job,scene,_image,{receipt,onBeforeSend}){generations.push(scene.generation);assert.equal(receipt,null);await onBeforeSend({key:`fixture-${scene.generation}`});return {path:video};}};
  let audits=0;
  await processBrandJobV2(job,{client,muse,auditor:{async verify(){return ++audits===1?{ok:false,reason:'CUT_OFF_SPEECH'}:{ok:true};}},workRoot:root,workerId:randomUUID(),leaseToken:randomUUID(),retryDelayMs:0});
  const patches=client.patches.filter(p=>p.name==='update_brand_scene_v2').map(p=>p.args.p_patch);
  assert.deepEqual(generations,[0,1]);
  assert.ok(patches.some(p=>p.submission_state==='sending'&&p.request_receipt?.key==='fixture-0'));
  assert.ok(patches.some(p=>p.status==='generating'&&p.generation===1&&p.submission_state==='not_sent'&&p.request_receipt===null));
  assert.equal(patches.at(-1).status,'done');
});

test('explicit Muse refusal retries a fresh generation with unchanged approved dialogue and original image',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v3-rejected-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const video=path.join(root,'accepted.mp4');await clip(video,'green',10);
  const image=Buffer.alloc(128,3);image.set([137,80,78,71,13,10,26,10]);
  const dialogue='Đây là lời thoại của khách, không được sửa sau khi duyệt.';
  const plan=[{index:1,seconds:10,dialogue}];
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,
    workflow_phase:'video',status:'generating',reference_path:'owner/reference',reference_sha256:hash(image),
    scene_count:1,scene_seconds:10,plan,attempt:1,max_attempts:3};
  const scenes=new Map([[job.id,[{scene_index:1,status:'waiting',generation:0,request_receipt:null}]]]);
  const client=fakeClient([job],[image],scenes),generations=[];
  const muse={async beginJob(){return {url:'https://muse.ai/thread/approved'};},
    async storyboard(){assert.fail('Approved script must not be rewritten');},
    async generateSceneV2(_job,scene,imagePath,{receipt,onBeforeSend}){
      assert.equal(scene.dialogue,dialogue);assert.equal(hash(await readFile(imagePath)),job.reference_sha256);
      generations.push(scene.generation);assert.equal(receipt,null);
      await onBeforeSend({key:`generation-${scene.generation}`});
      if(scene.generation===0)throw Object.assign(Error('Muse did not deliver a vertical clip'),{code:'MUSE_OUTPUT_REJECTED',retryable:false});
      return {path:video};
    }};
  const result=await processBrandJobV2(job,{client,muse,auditor:{async verify(){return {ok:true};}},workRoot:root,workerId:randomUUID(),leaseToken:randomUUID(),retryDelayMs:0});
  assert.deepEqual(generations,[0,1]);assert.ok(client.objects.has('brand-videos/'+result));
  const patches=client.patches.filter(p=>p.name==='update_brand_scene_v2').map(p=>p.args.p_patch);
  assert.ok(patches.some(p=>p.generation===1&&p.request_receipt===null&&p.submission_state==='not_sent'));
  assert.equal(patches.at(-1).status,'done');
});

test('one uncertain Muse timeout marks the scene failed and keeps its receipt without resubmitting',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v3-timeout-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const image=Buffer.alloc(128,4);image.set([137,80,78,71,13,10,26,10]);
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,
    workflow_phase:'video',status:'generating',reference_path:'owner/reference',reference_sha256:hash(image),
    scene_count:1,scene_seconds:10,plan:[{index:1,seconds:10,dialogue:'Lời khách đã duyệt.'}]};
  const scenes=new Map([[job.id,[{scene_index:1,status:'waiting',generation:0,request_receipt:null}]]]);
  const client=fakeClient([job],[image],scenes),generations=[];
  const muse={async beginJob(){return {url:'https://muse.ai/thread/approved'};},
    async generateSceneV2(_job,scene,_image,{receipt,onBeforeSend}){
      generations.push(scene.generation);
      if(!receipt)await onBeforeSend({key:'uncertain-request'});
      else assert.equal(receipt.key,'uncertain-request');
      throw Object.assign(Error('Result not yet visible'),{code:'MUSE_TIMEOUT',retryable:true});
    }};
  await assert.rejects(processBrandJobV2(job,{client,muse,workRoot:root,workerId:randomUUID(),leaseToken:randomUUID(),retryDelayMs:0}),
    error=>error.code==='MUSE_TIMEOUT');
  assert.deepEqual(generations,[0]);
  const patches=client.patches.filter(p=>p.name==='update_brand_scene_v2').map(p=>p.args.p_patch);
  assert.equal(patches.filter(p=>p.request_receipt?.key==='uncertain-request').length,1);
  assert.ok(patches.some(p=>p.request_receipt?.key==='uncertain-request'));
  assert.equal(patches.some(p=>p.generation!==undefined||p.request_receipt===null),false);
  assert.ok(patches.some(p=>p.status==='error'&&p.error_code==='MUSE_TIMEOUT'));
});

test('a timed-out job is recorded as failed and the next member job can finish independently',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v3-queue-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const images=[Buffer.alloc(128,8),Buffer.alloc(128,9)];images[0].set([137,80,78,71,13,10,26,10]);images[1].set([137,80,78,71,13,10,26,10]);
  const jobs=images.map((image,index)=>({id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,
    workflow_phase:'video',status:'generating',reference_path:`owner-${index}/reference`,reference_sha256:hash(image),
    scene_count:1,scene_seconds:10,attempt:1,max_attempts:3,plan:[{index:1,seconds:10,dialogue:`Approved dialogue ${index}`}]}));
  const scenes=new Map(jobs.map(job=>[job.id,[{scene_index:1,status:'waiting',generation:0,request_receipt:null}]]));
  const client=fakeClient(jobs,images,scenes),video=path.join(root,'second-member-scene.mp4');await clip(video,'blue',10);
  const muse={async beginJob(){return {url:'https://muse.ai/thread/isolated'};},async generateSceneV2(job,scene,imagePath,{onBeforeSend}){
    assert.equal(hash(await readFile(imagePath)),job.reference_sha256);
    if(job.id===jobs[0].id){await onBeforeSend({key:'saved-receipt'});throw Object.assign(Error('generation timed out'),{code:'MUSE_TIMEOUT',retryable:true});}
    await onBeforeSend({key:'second-member'});return {path:video};
  }};
  let timeout;
  await assert.rejects(processBrandJobV2(jobs[0],{client,muse,workRoot:root,workerId:'worker',leaseToken:'lease'}),error=>{timeout=error;return error.code==='MUSE_TIMEOUT';});
  await failBrandJobV2(jobs[0],timeout,{client,workerId:'worker',leaseToken:'lease'});
  const finished=await processBrandJobV2(jobs[1],{client,muse,auditor:{async verify(){return {ok:true};}},workRoot:root,workerId:'worker',leaseToken:'lease'});
  assert.ok(client.patches.some(p=>p.name==='update_brand_job_v2'&&p.args.p_id===jobs[0].id&&p.args.p_patch.status==='error'));
  assert.ok(client.objects.has('brand-videos/'+finished));assert.ok(finished.includes(jobs[1].id));assert.ok(!finished.includes(jobs[0].id));
  assert.equal(client.sceneData.get(jobs[1].id)[0].status,'done');
});

test('repeated explicit Muse refusals stop after the bounded third generation',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-v3-refusal-limit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const image=Buffer.alloc(128,5);image.set([137,80,78,71,13,10,26,10]);
  const job={id:randomUUID(),user_id:randomUUID(),claim_token:randomUUID(),schema_version:3,
    workflow_phase:'video',status:'generating',reference_path:'owner/reference',reference_sha256:hash(image),
    scene_count:1,scene_seconds:10,plan:[{index:1,seconds:10,dialogue:'Lời khách đã duyệt.'}]};
  const scenes=new Map([[job.id,[{scene_index:1,status:'waiting',generation:0,request_receipt:null}]]]);
  const client=fakeClient([job],[image],scenes),generations=[];
  const muse={async beginJob(){return {url:'https://muse.ai/thread/approved'};},
    async generateSceneV2(_job,scene,_image,{onBeforeSend}){
      generations.push(scene.generation);await onBeforeSend({key:`rejected-${scene.generation}`});
      throw Object.assign(Error('Muse cannot deliver vertical format'),{code:'MUSE_OUTPUT_REJECTED',retryable:false});
    }};
  await assert.rejects(processBrandJobV2(job,{client,muse,workRoot:root,workerId:randomUUID(),leaseToken:randomUUID(),retryDelayMs:0}),
    error=>error.code==='MUSE_OUTPUT_REJECTED'&&error.retryable===false);
  assert.deepEqual(generations,[0,1,2]);
  const patches=client.patches.filter(p=>p.name==='update_brand_scene_v2').map(p=>p.args.p_patch);
  assert.deepEqual(patches.filter(p=>p.generation!==undefined).map(p=>p.generation),[1,2]);
  assert.equal([...client.objects.keys()].some(key=>key.startsWith('brand-videos/')),false);
});
