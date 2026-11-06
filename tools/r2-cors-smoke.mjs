// Checks browser preflight without creating an object or printing credentials.
import {randomUUID} from 'node:crypto';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
console.log('READY_FOR_R2_CORS_TEST');
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.includes('\n')||input.includes('\r'))break;}
if(process.stdin.isTTY)process.stdin.setRawMode(false);
const {account,bucket,accessKeyId,secretAccessKey}=JSON.parse(input);
const client=new S3Client({region:'auto',endpoint:`https://${account}.r2.cloudflarestorage.com`,forcePathStyle:true,
  credentials:{accessKeyId,secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED'});
const url=await getSignedUrl(client,new PutObjectCommand({Bucket:bucket,Key:`__muse_cors_test__/${randomUUID()}`,ContentType:'image/png',ContentLength:1}),
  {expiresIn:60,signableHeaders:new Set(['content-type','content-length'])});
const check=async origin=>fetch(url,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'content-type'}});
const allowed=await check('https://muse-brand-studio.vercel.app');
if(!allowed.ok||allowed.headers.get('access-control-allow-origin')!=='https://muse-brand-studio.vercel.app')throw Error('Production CORS preflight failed');
const blocked=await check('https://unrelated.example');
if(blocked.headers.get('access-control-allow-origin'))throw Error('Unrelated origin was allowed');
console.log('R2_PRODUCTION_CORS_ALLOW_AND_DENY_OK');
