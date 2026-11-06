import {createClient} from '@supabase/supabase-js';
import {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';

const VIDEO_BUCKET='brand-videos',REFERENCE_BUCKET='brand-references';
const TYPES={
  [VIDEO_BUCKET]:new Set(['video/mp4','image/png','image/jpeg','image/webp']),
  [REFERENCE_BUCKET]:new Set(['image/png','image/jpeg','image/webp'])
};
const LIMITS={[VIDEO_BUCKET]:100*1024*1024,[REFERENCE_BUCKET]:10*1024*1024};
const ACTIVE=new Set(['uploading','queued','planning','generating','joining','script_queued','video_queued']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyFor=(bucket,name)=>`${bucket==='brand-videos'?'outputs':'references'}/${name}`;
function fail(status,message){throw Object.assign(Error(message),{status});}
function validateName(name,job){
  if(typeof name!=='string'||!name.startsWith(`${job.user_id}/${job.id}/`)||name.length>800||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))fail(400,'Đường dẫn file không hợp lệ.');
}
function isBeforeExpiry(expiry,now){return !expiry||Number.isFinite(Date.parse(expiry))&&Date.parse(expiry)>now;}
function validPathForRead(job,bucket,name,now){
  if(bucket===REFERENCE_BUCKET)return job.reference_path===name&&isBeforeExpiry(job.reference_expires_at,now);
  if(job.retention_status==='expired')return false;
  const active=ACTIVE.has(job.status);
  if(job.status==='done'&&job.final_path===name&&isBeforeExpiry(job.output_expires_at,now))return true;
  return (job.brand_scenes||[]).some(scene=>scene.output_path===name&&scene.status==='done'&&(active||isBeforeExpiry(scene.output_expires_at,now)));
}
function providerFor(job,bucket){return bucket===REFERENCE_BUCKET?job.reference_storage_provider:job.storage_provider;}

export function createMediaHandler({makeClient=createClient,s3,sign=getSignedUrl,storageBucket,projectUrl,publicKey,now=Date.now}={}){
  return async function handler(req,res){
    res.setHeader('Cache-Control','no-store, private');
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method!=='POST')return res.status(405).json({error:'Phương thức không được hỗ trợ.'});
    try{
      if(!s3||!storageBucket||!projectUrl||!publicKey)fail(503,'Kho R2 chưa được cấu hình.');
      const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
      if(!body||typeof body!=='object'||!UUID.test(body.jobId||''))fail(400,'Yêu cầu không hợp lệ.');
      const {action,bucket,jobId}=body;if(!TYPES[bucket])fail(400,'Kho file không hợp lệ.');
      if(action==='expire'||action==='expire_abandoned'){
        if(!UUID.test(body.claim||'')||!Array.isArray(body.paths)||body.paths.length<1||body.paths.length>10||body.paths.some(path=>typeof path!=='string'||path.length>800))fail(400,'Yêu cầu xóa không hợp lệ.');
        const anonymous=makeClient(projectUrl,publicKey,{auth:{persistSession:false,autoRefreshToken:false}});
        const verified=await anonymous.rpc(action==='expire'?'authorize_r2_expiry':'authorize_r2_abandoned_expiry',{p_id:jobId,p_claim:body.claim,p_bucket:bucket,p_paths:body.paths});
        if(verified.error||verified.data!==true)fail(403,'Không có quyền xóa các file này.');
        for(const name of new Set(body.paths))await s3.send(new DeleteObjectCommand({Bucket:storageBucket,Key:keyFor(bucket,name)}));
        return res.status(200).json({ok:true});
      }
      const authorization=req.headers.authorization||'';
      const token=authorization.match(/^Bearer\s+(.+)$/i)?.[1];if(!token)fail(401,'Cần đăng nhập.');
      const client=makeClient(projectUrl,publicKey,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
      const auth=await client.auth.getUser(token);if(auth.error||!auth.data?.user?.id)fail(401,'Phiên đăng nhập đã hết hạn.');
      const query=await client.from('brand_jobs').select('id,user_id,status,reference_path,reference_expires_at,storage_provider,reference_storage_provider,final_path,output_expires_at,retention_status,brand_scenes(status,output_path,output_expires_at)').eq('id',jobId).maybeSingle();
      const job=query.data;if(query.error||!job)fail(404,'Không tìm thấy yêu cầu.');
      const name=body.path;validateName(name,job);
      if(providerFor(job,bucket)!=='r2')fail(409,'File này không nằm trong kho R2.');
      if(action==='get'){
        if(!validPathForRead(job,bucket,name,now()))fail(403,'File chưa sẵn sàng hoặc đã hết hạn.');
        const expiry=bucket===REFERENCE_BUCKET?job.reference_expires_at:job.final_path===name?job.output_expires_at:(job.brand_scenes||[]).find(scene=>scene.output_path===name)?.output_expires_at;
        const remaining=expiry?Math.floor((Date.parse(expiry)-now())/1000):600;
        const expiresIn=Math.max(1,Math.min(600,Number.isFinite(remaining)?remaining:600));
        const url=await sign(s3,new GetObjectCommand({Bucket:storageBucket,Key:keyFor(bucket,name)}),{expiresIn});
        return res.status(200).json({url});
      }
      if(!['put','finalize'].includes(action))fail(400,'Thao tác không hợp lệ.');
      const size=Number(body.size),contentType=body.contentType;
      if(!Number.isSafeInteger(size)||size<1||size>LIMITS[bucket]||!TYPES[bucket].has(contentType))fail(400,'Dung lượng hoặc định dạng file không hợp lệ.');
      if(bucket===REFERENCE_BUCKET){
        if(job.user_id!==auth.data.user.id||job.status!=='uploading'||job.reference_path!==name)fail(403,'Không có quyền tải ảnh cho yêu cầu này.');
      }else{
        const allowed=await client.rpc('can_upload_brand_video',{p_name:name});
        if(allowed.error||allowed.data!==true)fail(403,'Worker chưa có quyền lưu kết quả này.');
      }
      const key=keyFor(bucket,name);
      if(action==='put'){
        // Register before issuing a URL: even a client that disconnects after
        // uploading must leave a server-side cleanup record.
        const tracked=await client.rpc('register_r2_upload',{p_id:jobId,p_bucket:bucket,p_path:name});
        if(tracked.error||tracked.data!==true)fail(409,'Không thể chuẩn bị lưu file. Hãy thử lại.');
        const url=await sign(s3,new PutObjectCommand({Bucket:storageBucket,Key:key,ContentType:contentType,ContentLength:size}),{expiresIn:600,signableHeaders:new Set(['content-type','content-length'])});
        return res.status(200).json({url});
      }
      const head=await s3.send(new HeadObjectCommand({Bucket:storageBucket,Key:key}));
      if(head.ContentLength!==size||head.ContentType!==contentType)fail(409,'File trên R2 chưa khớp yêu cầu tải lên.');
      // A zero-byte marker keeps existing Supabase ownership/lease checks and
      // the established retention machinery intact; content lives only in R2.
      const stored=await client.storage.from(bucket).upload(name,new Uint8Array(0),{contentType,upsert:false});
      if(stored.error){
        const existing=await client.storage.from(bucket).download(name);
        if(existing.error||existing.data.size!==0)fail(409,'Không xác nhận được file của yêu cầu.');
      }
      const tracked=await client.rpc('register_r2_upload',{p_id:jobId,p_bucket:bucket,p_path:name});
      if(tracked.error||tracked.data!==true)fail(409,'Không xác nhận được thời hạn lưu file. Hãy thử lại.');
      return res.status(200).json({ok:true});
    }catch(error){
      const status=Number.isInteger(error?.status)?error.status:500;
      if(status>=500)console.error('r2-media-gateway failed',error?.name||'Error');
      return res.status(status).json({error:status>=500?'Kho file đang gián đoạn. Hãy thử lại.':error.message});
    }
  };
}

const account=process.env.R2_ACCOUNT_ID,bucket=process.env.R2_BUCKET_NAME;
const configured=account&&process.env.R2_ACCESS_KEY_ID&&process.env.R2_SECRET_ACCESS_KEY;
const s3=configured?new S3Client({region:'auto',endpoint:`https://${account}.r2.cloudflarestorage.com`,forcePathStyle:true,
  credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY},
  requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'}):null;
export default createMediaHandler({s3,storageBucket:bucket,projectUrl:process.env.VITE_SUPABASE_URL,publicKey:process.env.VITE_SUPABASE_PUBLISHABLE_KEY});
