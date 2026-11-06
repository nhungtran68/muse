import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadMedia,downloadMedia,signedMediaUrl} from '../shared/media-storage.mjs';

test('R2 upload signs, transfers the original bytes, and finalizes for the same job',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const calls=[],bytes=new Uint8Array([1,2,3,4]);
 globalThis.fetch=async(url,options={})=>{
  calls.push({url,options});
  if(url==='https://storage.example/signed')return new Response(null,{status:200});
  const input=JSON.parse(options.body);
  return Response.json(input.action==='put'?{url:'https://storage.example/signed'}:{ok:true});
 };
 const client={auth:{getSession:async()=>({data:{session:{access_token:'session-token'}}})}};
 const spec={provider:'r2',bucket:'brand-videos',jobId:'job-a',path:'user-a/job-a/claim/result.mp4',contentType:'video/mp4',data:bytes,origin:'https://studio.example'};
 await uploadMedia(client,spec);
 assert.equal(calls.length,3);
 assert.equal(calls[0].options.headers.Authorization,'Bearer session-token');
 assert.deepEqual(JSON.parse(calls[0].options.body),{action:'put',bucket:spec.bucket,path:spec.path,jobId:spec.jobId,contentType:spec.contentType,size:4});
 assert.strictEqual(calls[1].options.body,bytes);
 assert.deepEqual(JSON.parse(calls[2].options.body),{action:'finalize',bucket:spec.bucket,path:spec.path,jobId:spec.jobId,contentType:spec.contentType,size:4});
});

test('legacy and R2 downloads are signed for attachment while previews remain inline',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const calls=[];
 globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({url:'https://r2.example/file'});};
 const client={storage:{from:()=>({createSignedUrl:async(...args)=>{calls.push(args);return {data:{signedUrl:'https://storage.example/file'},error:null};}})}};
 const spec={bucket:'brand-videos',path:'owner/job/result.png',jobId:'job',token:'session',download:'muse-job.png',expiresIn:540};
 assert.equal(await signedMediaUrl(client,spec),'https://storage.example/file');
 assert.deepEqual(calls.shift(),[spec.path,540,{download:'muse-job.png'}]);
 assert.equal(await signedMediaUrl(client,{...spec,provider:'r2'}),'https://r2.example/file');
 assert.equal(calls.shift().download,true);
 await signedMediaUrl(client,{...spec,provider:'r2',download:undefined});
 assert.equal(calls.shift().download,undefined);
});

test('an interrupted R2 upload is never finalized, while legacy downloads stay in Supabase',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let requests=0;
 globalThis.fetch=async(url)=>{requests++;return url.endsWith('/api/media')?Response.json({url:'https://storage.example/fail'}):new Response(null,{status:500});};
 const client={storage:{from:()=>({download:async()=>({data:new Blob(['old']),error:null})})}};
 await assert.rejects(uploadMedia(client,{provider:'r2',bucket:'brand-videos',path:'x',jobId:'j',token:'s',contentType:'video/mp4',data:new Uint8Array([1]),origin:'https://studio.example'}));
 assert.equal(requests,2,'failed upload must not finalize a missing object');
 assert.equal(await (await downloadMedia(client,{bucket:'brand-videos',path:'old'})).text(),'old');
 assert.equal(requests,2,'legacy files must not call R2');
});
