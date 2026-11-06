// Optional integration test. Credentials are read once from stdin and never
// written to disk or output. Only a uniquely named test object is touched.
import {createHash,randomUUID} from 'node:crypto';
import {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';

let input='';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
console.log('READY_FOR_R2_TEST');
for await(const chunk of process.stdin){input+=chunk;if(input.includes('\n')||input.includes('\r'))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const {account,bucket,accessKeyId,secretAccessKey}=JSON.parse(input);
const client=new S3Client({region:'auto',endpoint:`https://${account}.r2.cloudflarestorage.com`,forcePathStyle:true,
  credentials:{accessKeyId,secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
const key=`__muse_smoke_test__/${randomUUID()}.bin`,size=100*1024*1024,type='video/mp4';
let cleanup=false;
try{
  const data=Buffer.alloc(size,0x5a),expected=createHash('sha256').update(data).digest('hex');
  const url=await getSignedUrl(client,new PutObjectCommand({Bucket:bucket,Key:key,ContentType:type,ContentLength:size}),
    {expiresIn:600,signableHeaders:new Set(['content-type','content-length'])});
  const put=await fetch(url,{method:'PUT',headers:{'content-type':type},body:data});
  if(!put.ok)throw Error(`Direct upload failed: ${put.status}`);
  const head=await client.send(new HeadObjectCommand({Bucket:bucket,Key:key}));
  if(head.ContentLength!==size||head.ContentType!==type)throw Error('Uploaded object metadata mismatch');
  const getUrl=await getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:key}),{expiresIn:600});
  const get=await fetch(getUrl);if(!get.ok||!get.body)throw Error(`Direct download failed: ${get.status}`);
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of get.body){hash.update(chunk);bytes+=chunk.length;}
  if(bytes!==size||hash.digest('hex')!==expected)throw Error('Downloaded object hash or size mismatch');
  console.log('R2_UPLOAD_DOWNLOAD_100_MIB_AND_HASH_OK');
}finally{
  await client.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));cleanup=true;
  try{await client.send(new HeadObjectCommand({Bucket:bucket,Key:key}));throw Error('Test object remains after deletion');}
  catch(error){if(error?.$metadata?.httpStatusCode!==404&&error?.name!=='NotFound')throw error;}
  if(cleanup)console.log('R2_TEST_OBJECT_DELETED_OK');
}
