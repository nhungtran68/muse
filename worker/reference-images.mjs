import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {downloadMedia} from '../shared/media-storage.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const invalid=message=>Object.assign(Error(message),{code:'REFERENCE_MISMATCH',retryable:false});

function imageExtension(bytes){
  if(bytes.length<8||bytes.length>10*1024*1024)throw invalid('Ảnh tham chiếu không hợp lệ.');
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
  throw invalid('Ảnh tham chiếu sai định dạng.');
}

export function imageReferences(job){
  if(!Array.isArray(job.reference_images)||!job.reference_images.length){
    if(typeof job.reference_path!=='string'||!(/^[a-f0-9]{64}$/.test(job.reference_sha256||'')))throw invalid('Ảnh tham chiếu của yêu cầu không hợp lệ.');
    return [{path:job.reference_path,sha256:job.reference_sha256}];
  }
  const references=job.reference_images;
  if(!references.length||references.length>5)throw invalid('Số ảnh tham chiếu không hợp lệ.');
  const prefix=`${job.user_id}/${job.id}/reference`;
  for(let index=0;index<references.length;index++){
    const item=references[index],expected=prefix+(index?`-${index+1}`:'');
    if(item?.path!==expected||!(/^[a-f0-9]{64}$/.test(item.sha256||'')))throw invalid('Danh sách ảnh tham chiếu của yêu cầu không khớp.');
  }
  if(references[0].path!==job.reference_path||references[0].sha256!==job.reference_sha256)throw invalid('Ảnh đầu tiên không khớp yêu cầu.');
  return references;
}

export async function downloadImageReferences(job,{client,dir,origin=process.env.MUSE_MEDIA_GATEWAY_ORIGIN}){
  const paths=[];
  for(const [index,entry] of imageReferences(job).entries()){
    const blob=await downloadMedia(client,{provider:job.reference_storage_provider,bucket:'brand-references',path:entry.path,jobId:job.id,origin});
    const bytes=Buffer.from(await blob.arrayBuffer());
    if(sha256(bytes)!==entry.sha256)throw invalid(`Ảnh tham chiếu ${index+1} không khớp tệp đã tải lên.`);
    const file=path.join(dir,`reference-${index+1}.${imageExtension(bytes)}`);
    await writeFile(file,bytes);paths.push(file);
  }
  return paths.length===1?paths[0]:paths;
}
