import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {probeVideo,joinScenes} from './ffmpeg.mjs';
import {assertGeneratedMediaSize} from '../shared/media-limits.mjs';
import {downloadMedia,uploadMedia} from '../shared/media-storage.mjs';
import {downloadImageReferences} from './reference-images.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Initial edit uploads are deliberately smaller than generated outputs: the
// connector and worker both validate the complete source in memory.
export const MAX_VIDEO_SOURCE_BYTES=25*1024*1024;
export function validateVideoSource(bytes,probe){
  if(!bytes?.length||bytes.length>MAX_VIDEO_SOURCE_BYTES)throw Object.assign(Error('Video đầu vào phải lớn hơn 0 và không quá 25 MB.'),{code:'VIDEO_INPUT_TOO_LARGE',retryable:false});
  const brands=['isom','iso2','iso3','iso4','iso5','iso6','mp41','mp42','avc1','M4V '];
  const boxSize=bytes.length>=16?bytes.readUInt32BE(0):0;
  if(bytes.toString('ascii',4,8)!=='ftyp'||boxSize<16||boxSize>bytes.length||!brands.includes(bytes.toString('ascii',8,12)))throw Object.assign(Error('Tệp đầu vào không phải video MP4 được hỗ trợ. Hãy xuất lại video dạng MP4.'),{code:'VIDEO_INPUT_INVALID',retryable:false});
  if(probe&&(!Number.isFinite(probe.duration)||probe.duration<=0||!Number.isFinite(probe.width)||probe.width<=0||!Number.isFinite(probe.height)||probe.height<=0))throw Object.assign(Error('Không đọc được hình ảnh hoặc thời lượng video đầu vào.'),{code:'VIDEO_INPUT_INVALID',retryable:false});
}
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

export async function processSingleMediaJob(job,{client,muse,workRoot,workerId,leaseToken,videoEditEnabled=process.env.MUSE_ENABLE_VIDEO_EDIT!=='0'}){
  const isImage=job.creation_mode==='image',kind=isImage?'image':'video';
  const isVideoEdit=job.reference_kind==='video';
  if(isVideoEdit&&!videoEditEnabled)throw Object.assign(Error('Chỉnh sửa video chưa được bật trên worker này.'),{code:'VIDEO_EDIT_UNAVAILABLE',retryable:false});
  if(isVideoEdit&&(job.creation_mode!=='video_free'||!job.reference_path||!/^[a-f0-9]{64}$/.test(job.reference_sha256||'')||job.storage_provider!=='r2'||job.output_r2_selected!==true))throw Object.assign(Error('Yêu cầu chỉnh sửa thiếu video nguồn hoặc quyền lưu kết quả R2.'),{code:'INVALID_VIDEO_EDIT_JOB',retryable:false});
  const expectedAction=isImage?'single_image_request':'single_free_video_request';
  if(!job.claim_token||!workerId||!leaseToken||job.schema_version!==2||job.scene_count!==1||job.scene_seconds!==null||job.plan?.length!==1||job.plan[0]?.index!==1||job.plan[0]?.action!==expectedAction)throw Object.assign(Error('Yêu cầu tạo nội dung không hợp lệ.'),{code:'INVALID_MEDIA_JOB',retryable:false});
  const auth={p_id:job.id,p_worker:workerId,p_token:leaseToken,p_claim:job.claim_token};
  const rpc=async(name,args)=>{const r=await client.rpc(name,args);if(r.error)throw r.error;return r.data;};
  const update=patch=>rpc('update_brand_scene_v2',{...auth,p_scene:1,p_patch:patch});
  const dir=path.join(workRoot,job.id,job.claim_token);await mkdir(dir,{recursive:true});
  let image=null;
  try{
  if(job.reference_path){
    if(!isVideoEdit)image=await downloadImageReferences(job,{client,dir});
    else{
    let result;
    try{result=await downloadMedia(client,{provider:job.reference_storage_provider,bucket:'brand-references',path:job.reference_path,jobId:job.id,origin:process.env.MUSE_MEDIA_GATEWAY_ORIGIN})}
    catch(error){if(isVideoEdit)throw Object.assign(Error('Chưa tải được video nguồn từ kho; sẽ thử lại an toàn.'),{code:'VIDEO_SOURCE_DOWNLOAD_FAILED',retryable:true});throw error;}
    if(isVideoEdit&&result.size>MAX_VIDEO_SOURCE_BYTES)throw Object.assign(Error('Video đầu vào vượt giới hạn 25 MB.'),{code:'VIDEO_INPUT_TOO_LARGE',retryable:false});
    const bytes=Buffer.from(await result.arrayBuffer());
    if(hash(bytes)!==job.reference_sha256)throw Object.assign(Error(isVideoEdit?'Video nguồn không khớp yêu cầu ban đầu.':'Ảnh tham chiếu không khớp yêu cầu ban đầu.'),{code:'REFERENCE_MISMATCH',retryable:false});
    if(isVideoEdit)validateVideoSource(bytes);
    image=path.join(dir,isVideoEdit?'mcp-video-edit-source.mp4':'reference.'+imageFormat(bytes).extension);await writeFile(image,bytes);
    if(isVideoEdit){
      try{validateVideoSource(bytes,await probeVideo(image));}
      catch(error){throw Object.assign(Error(error.code?error.message:'Không giải mã được video đầu vào. Hãy xuất lại video MP4 và thử lại.'),{code:error.code||'VIDEO_INPUT_INVALID',retryable:false});}
    }
    }
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
  assertGeneratedMediaSize(bytes.length);
  const key=`${job.user_id}/${job.id}/${job.claim_token}/result.${format.extension}`;
  try{
    await uploadMedia(client,{provider:job.storage_provider,bucket:'brand-videos',path:key,jobId:job.id,origin:process.env.MUSE_MEDIA_GATEWAY_ORIGIN,contentType:format.contentType,data:bytes});
    await rpc('complete_single_media_job',{...auth,p_path:key,p_sha256:hash(bytes),p_probe:{...probe,kind,content_type:format.contentType,duration:isImage?null:probe.duration}});
  }catch(error){
    await update({status:'error',error_code:'MUSE_TIMEOUT',error:'Đã nhận kết quả Muse nhưng chưa lưu xong. Có thể tiếp tục lấy kết quả cũ mà không gửi lại.'});
    throw Object.assign(error,{code:'MUSE_TIMEOUT',retryable:true});
  }
  console.log(`Yêu cầu ${job.id} · đã lưu ${kind} hợp lệ${isImage?'':` · ${probe.duration} giây`}.`);
  return key;
  }finally{
    if(isVideoEdit&&image)await unlink(image).catch(error=>{if(error?.code!=='ENOENT')console.warn('Chưa xóa được bản video nguồn tạm của yêu cầu.');});
  }
}
