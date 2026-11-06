import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {probeVideo,joinScenes} from './ffmpeg.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function imageFormat(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {extension:'png',contentType:'image/png'};
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {extension:'jpg',contentType:'image/jpeg'};
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return {extension:'webp',contentType:'image/webp'};
  throw Object.assign(Error('Muse trả về tệp không phải ảnh PNG, JPEG hoặc WebP hợp lệ.'),{code:'MEDIA_INVALID',retryable:true});
}
export function validateFlexibleMedia(probe,kind){
  if(!Number.isFinite(probe.width)||!Number.isFinite(probe.height)||probe.width<1||probe.height<1)throw Error('Không đọc được kích thước của kết quả Muse.');
  if(kind==='video'&&(!Number.isFinite(probe.duration)||probe.duration<=0))throw Error('Video Muse trả về không có thời lượng hợp lệ.');
}

export async function processSingleMediaJob(job,{client,muse,workRoot,workerId,leaseToken}){
  const isImage=job.creation_mode==='image',kind=isImage?'image':'video';
  const expectedAction=isImage?'single_image_request':'single_free_video_request';
  if(!job.claim_token||!workerId||!leaseToken||job.schema_version!==2||job.scene_count!==1||job.scene_seconds!==null||job.plan?.length!==1||job.plan[0]?.index!==1||job.plan[0]?.action!==expectedAction)throw Object.assign(Error('Yêu cầu tạo nội dung không hợp lệ.'),{code:'INVALID_MEDIA_JOB',retryable:false});
  const auth={p_id:job.id,p_worker:workerId,p_token:leaseToken,p_claim:job.claim_token};
  const rpc=async(name,args)=>{const r=await client.rpc(name,args);if(r.error)throw r.error;return r.data;};
  const update=patch=>rpc('update_brand_scene_v2',{...auth,p_scene:1,p_patch:patch});
  const dir=path.join(workRoot,job.id,job.claim_token);await mkdir(dir,{recursive:true});
  let image=null;
  if(job.reference_path){
    const result=await client.storage.from('brand-references').download(job.reference_path);if(result.error)throw result.error;
    const bytes=Buffer.from(await result.data.arrayBuffer());
    if(hash(bytes)!==job.reference_sha256)throw Object.assign(Error('Ảnh tham chiếu không khớp yêu cầu ban đầu.'),{code:'REFERENCE_MISMATCH',retryable:false});
    image=path.join(dir,'reference.'+imageFormat(bytes).extension);await writeFile(image,bytes);
  }
  const conversation=await muse.beginJob(job);
  await rpc('update_brand_job_v2',{...auth,p_patch:{conversation_ref:conversation,status:'generating'}});
  const stored=await client.from('brand_scenes').select('*').eq('job_id',job.id);if(stored.error)throw stored.error;
  const previous=stored.data.find(scene=>scene.scene_index===1);
  if(!previous||previous.action!==expectedAction)throw Object.assign(Error('Không tìm thấy dữ liệu của đúng yêu cầu.'),{code:'INVALID_MEDIA_JOB',retryable:false});
  let receipt=previous.request_receipt||null;
  await update({status:'generating'});
  let output;
  try{
    console.log(`Yêu cầu ${job.id} · chế độ ${job.creation_mode} · ${receipt?'tiếp tục nhận kết quả cũ':'gửi một yêu cầu Muse'}`);
    output=await muse.generateSceneV2(job,{...job.plan[0],generation:previous.generation||0},image,{
      receipt,
      onConversation:ref=>rpc('update_brand_job_v2',{...auth,p_patch:{conversation_ref:ref}}),
      onBeforeSend:async next=>{await update({submission_state:'sending',request_receipt:next});receipt=next;},
      onSubmitted:()=>update({submission_state:'sent'})
    });
  }catch(error){
    if(receipt&&!error.code){error.code='MUSE_TIMEOUT';error.retryable=true;}
    const confirmedFailure=['MUSE_OUTPUT_REJECTED','MEDIA_INVALID'].includes(error.code);
    await update({status:'error',error_code:error.code||'MUSE_ERROR',error:String(error.message||'Muse chưa trả kết quả.').slice(0,400),
      ...(confirmedFailure?{submission_state:'not_sent',request_receipt:null}:{})});
    if(confirmedFailure)error.retryable=true;
    throw error;
  }
  // Validate the real file; a text acknowledgement never completes a job.
  let file=output.path,bytes,format,probe;
  try{
    bytes=await readFile(file);format=isImage?imageFormat(bytes):{extension:'mp4',contentType:'video/mp4'};
    probe=await probeVideo(file);validateFlexibleMedia(probe,kind);
    if(!isImage&&!bytes.subarray(0,64).includes(Buffer.from('ftyp')))throw Error('Muse chưa trả về một video MP4 hợp lệ.');
  }catch(error){
    await update({status:'error',submission_state:'not_sent',request_receipt:null,error_code:'MEDIA_INVALID',error:String(error.message).slice(0,400)});
    throw Object.assign(error,{code:'MEDIA_INVALID',retryable:true});
  }
  if(!isImage){
    if(probe.codec!=='h264'){
      const playable=path.join(dir,'playable.mp4');probe=await joinScenes([file],playable,probe.duration);file=playable;bytes=await readFile(file);
    }
  }
  if(bytes.length>50*1024*1024)throw Object.assign(Error('Kết quả lớn hơn giới hạn lưu 50 MB hiện tại. Hãy giảm độ dài hoặc độ phân giải rồi gửi yêu cầu mới.'),{code:'MEDIA_TOO_LARGE',retryable:false});
  const key=`${job.user_id}/${job.id}/${job.claim_token}/result.${format.extension}`;
  try{
    const saved=await client.storage.from('brand-videos').upload(key,bytes,{contentType:format.contentType,upsert:false});if(saved.error)throw saved.error;
    await rpc('complete_single_media_job',{...auth,p_path:key,p_sha256:hash(bytes),p_probe:{...probe,kind,content_type:format.contentType,duration:isImage?null:probe.duration}});
  }catch(error){
    await update({status:'error',error_code:'MUSE_TIMEOUT',error:'Đã nhận kết quả Muse nhưng chưa lưu xong. Có thể tiếp tục lấy kết quả cũ mà không gửi lại.'});
    throw Object.assign(error,{code:'MUSE_TIMEOUT',retryable:true});
  }
  console.log(`Yêu cầu ${job.id} · đã lưu ${kind} hợp lệ${isImage?'':` · ${probe.duration} giây`}.`);
  return key;
}
