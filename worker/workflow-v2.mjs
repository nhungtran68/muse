import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {joinScenes,probeVideo,validateScene} from './ffmpeg.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function extension(bytes){
  if(bytes.length<100||bytes.length>10*1024*1024)throw Error('Ảnh tham chiếu không hợp lệ.');
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes[0]===255&&bytes[1]===216)return 'jpg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
  throw Error('Ảnh tham chiếu sai định dạng.');
}
async function rpc(client,name,args){const result=await client.rpc(name,args);if(result.error)throw result.error;return result.data;}
async function download(client,bucket,key){const result=await client.storage.from(bucket).download(key);if(result.error)throw result.error;return Buffer.from(await result.data.arrayBuffer());}
async function upload(client,key,file){const result=await client.storage.from('brand-videos').upload(key,await readFile(file),{contentType:'video/mp4',upsert:false});if(result.error)throw result.error;}

export async function processBrandJobV2(job,{client,muse,auditor,workRoot,workerId,leaseToken}){
  if(job.schema_version!==2||!job.claim_token||!workerId||!leaseToken)throw Error('Thiếu quyền xử lý của yêu cầu.');
  const auth={p_id:job.id,p_worker:workerId,p_token:leaseToken,p_claim:job.claim_token};
  const updateJob=patch=>rpc(client,'update_brand_job_v2',{...auth,p_patch:patch});
  const updateScene=(index,patch)=>rpc(client,'update_brand_scene_v2',{...auth,p_scene:index,p_patch:patch});
  const dir=path.join(workRoot,job.id,job.claim_token);await mkdir(dir,{recursive:true});
  const reference=await download(client,'brand-references',job.reference_path);
  if(sha256(reference)!==job.reference_sha256)throw Object.assign(Error('Ảnh tham chiếu không khớp với ảnh đã gửi.'),{code:'REFERENCE_MISMATCH',retryable:false});
  const image=path.join(dir,'reference.'+extension(reference));await writeFile(image,reference);
  const conversation=await muse.beginJob(job);
  await updateJob({conversation_ref:conversation});
  let plan=job.plan;
  if(!Array.isArray(plan)||plan.length!==job.scene_count){
    const storyboard=await muse.storyboard(job,image,{onConversation:ref=>updateJob({conversation_ref:ref})});plan=storyboard.scenes;
    await updateJob({status:'generating',plan,analysis:storyboard.analysis,script_outline:storyboard.outline});
  }else await updateJob({status:'generating'});
  const stored=await client.from('brand_scenes').select('*').eq('job_id',job.id);
  if(stored.error)throw stored.error;
  const scenes=new Map(stored.data.map(s=>[s.scene_index,s])),files=[],hashes=new Set();
  for(const scene of plan){
    const previous=scenes.get(scene.index);
    let file;
    if(previous?.status==='done'){
      const data=await download(client,'brand-videos',previous.output_path);
      if(sha256(data)!==previous.output_sha256)throw Object.assign(Error(`Cảnh ${scene.index} lưu trữ không toàn vẹn.`),{code:'STORED_SCENE_MISMATCH',retryable:false});
      file=path.join(dir,`scene-${scene.index}.mp4`);await writeFile(file,data);
    }else{
      await updateScene(scene.index,{status:'generating'});
      const generation=Number(previous?.generation||0);
      const video=await muse.generateSceneV2(job,{...scene,generation},image,{
        receipt:previous?.request_receipt,
        onBeforeSend:receipt=>updateScene(scene.index,{status:'generating',submission_state:'sending',request_receipt:receipt})
      });
      file=video.path;
      const meta=await probeVideo(file);validateScene(meta,job.scene_seconds);
      if(Math.abs(meta.duration-job.scene_seconds)>.4)throw Object.assign(Error(`Cảnh ${scene.index} sai thời lượng yêu cầu.`),{code:'SCENE_DURATION_MISMATCH',retryable:false});
      const audit=await auditor.verify(file,scene,job.scene_seconds);
      if(!audit.ok){
        const retryable=generation<2&&(job.attempt??0)<(job.max_attempts??3);
        const detail=`Cảnh ${scene.index}: lời thoại không khớp hoặc chưa được đọc hết (${audit.reason}).`;
        await updateScene(scene.index,{status:'error',...(retryable?{generation:generation+1,submission_state:'not_sent',request_receipt:null}:{}),speech_audit:audit,error_code:audit.reason||'SPEECH_UNVERIFIED',error:detail});
        throw Object.assign(Error(retryable?detail+' Có thể thử tạo lại cảnh này.':detail+' Cần quản trị viên kiểm tra.'),{code:audit.reason||'SPEECH_UNVERIFIED',retryable});
      }
      const data=await readFile(file),fingerprint=sha256(data);
      if(hashes.has(fingerprint))throw Object.assign(Error('Video các cảnh bị trùng.'),{code:'DUPLICATE_SCENE',retryable:false});
      const key=`${job.user_id}/${job.id}/${job.claim_token}/scenes/${String(scene.index).padStart(2,'0')}.mp4`;
      await upload(client,key,file);
      await updateScene(scene.index,{status:'done',submission_state:'downloaded',output_path:key,duration:meta.duration,output_sha256:fingerprint,speech_audit:audit});
    }
    const meta=await probeVideo(file);validateScene(meta,job.scene_seconds);
    if(Math.abs(meta.duration-job.scene_seconds)>.4)throw Object.assign(Error(`Cảnh ${scene.index} đã lưu sai thời lượng yêu cầu.`),{code:'SCENE_DURATION_MISMATCH',retryable:false});
    const fingerprint=sha256(await readFile(file));
    if(hashes.has(fingerprint))throw Object.assign(Error('Video các cảnh bị trùng.'),{code:'DUPLICATE_SCENE',retryable:false});
    hashes.add(fingerprint);files.push(file);
  }
  await updateJob({status:'joining'});
  const final=path.join(dir,'final.mp4'),probe=await joinScenes(files,final,job.scene_count*job.scene_seconds);
  if(Math.abs(probe.duration-job.scene_count*job.scene_seconds)>=.7)throw Object.assign(Error('Video ghép sai tổng thời lượng yêu cầu.'),{code:'FINAL_DURATION_MISMATCH',retryable:false});
  const finalAudit=await auditor.verify(final,{dialogue:plan.map(s=>s.dialogue).filter(Boolean).join(' '),source_quotes:plan.flatMap(s=>s.source_quotes||[])},job.scene_count*job.scene_seconds);
  if(!finalAudit.ok)throw Object.assign(Error('Lời thoại trong video ghép chưa được xác nhận đầy đủ.'),{code:'FINAL_SPEECH_UNVERIFIED',retryable:false});
  const finalPath=`${job.user_id}/${job.id}/${job.claim_token}/final.mp4`;
  await upload(client,finalPath,final);
  await updateJob({status:'done',final_path:finalPath,final_probe:{...probe,speech_audit:finalAudit}});
  return finalPath;
}

export async function failBrandJobV2(job,error,{client,workerId,leaseToken}){
  const message=String(error?.message||'Không thể tạo video.').split('\n')[0].slice(0,400);
  return rpc(client,'update_brand_job_v2',{p_id:job.id,p_worker:workerId,p_token:leaseToken,p_claim:job.claim_token,p_patch:{status:'error',error:message,error_code:error?.code||'WORKER_ERROR',retryable:error?.retryable!==false&&(job.attempt??0)<(job.max_attempts??3)}});
}
