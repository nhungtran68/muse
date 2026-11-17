import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {downloadImageReferences,imageReferences} from './reference-images.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64');

test('worker downloads and verifies five separate photos for one owner job',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'muse-five-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const owner=randomUUID(),id=randomUUID(),references=[1,2,3,4,5].map(index=>({path:`${owner}/${id}/reference${index===1?'':`-${index}`}`,sha256:sha256(png)}));
  const job={id,user_id:owner,reference_path:references[0].path,reference_sha256:references[0].sha256,reference_images:references,reference_storage_provider:'supabase'};
  const downloads=[];
  const client={storage:{from:()=>({download:async key=>{downloads.push(key);return {data:new Blob([png]),error:null};}})}};
  const files=await downloadImageReferences(job,{client,dir});
  assert.equal(files.length,5);assert.deepEqual(downloads,references.map(item=>item.path));
  for(const [index,file] of files.entries()){
    assert.match(file,new RegExp(`reference-${index+1}\\.png$`));
    assert.deepEqual(await readFile(file),png);
  }
});

test('worker rejects a swapped cross-job path before downloading',()=>{
  const owner=randomUUID(),id=randomUUID(),hash=sha256(png),first=`${owner}/${id}/reference`;
  const job={id,user_id:owner,reference_path:first,reference_sha256:hash,reference_images:[{path:first,sha256:hash},{path:`${owner}/${randomUUID()}/reference-2`,sha256:hash}]};
  assert.throws(()=>imageReferences(job),{code:'REFERENCE_MISMATCH'});
});
