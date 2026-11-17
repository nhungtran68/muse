import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,utimes,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {cleanupVideoEditTemp} from './video-edit-temp.mjs';

test('cleanup removes only stale edit sources inside job and claim directories',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'muse-edit-cleanup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const job='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',claim='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const dir=path.join(root,job,claim);await mkdir(dir,{recursive:true});
 const stale=path.join(dir,'mcp-video-edit-source.mp4'),unrelated=path.join(dir,'reference.mp4');
 await writeFile(stale,'source');await writeFile(unrelated,'keep');await utimes(stale,new Date(0),new Date(0));
 assert.equal(await cleanupVideoEditTemp(root),1);await assert.rejects(readFile(stale),{code:'ENOENT'});assert.equal(String(await readFile(unrelated)),'keep');
 await writeFile(stale,'fresh');assert.equal(await cleanupVideoEditTemp(root),0);assert.equal(String(await readFile(stale)),'fresh');
});
