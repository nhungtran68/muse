import {readdir,lstat,unlink} from 'node:fs/promises';
import path from 'node:path';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Called only while the worker is idle. Never traverse links or delete files
// outside this feature's per-job, per-claim temporary filename.
export async function cleanupVideoEditTemp(root,{now=Date.now(),maxAgeMs=60*60*1000}={}){
  let jobs;try{jobs=await readdir(root,{withFileTypes:true})}catch(error){if(error?.code==='ENOENT')return 0;throw error;}
  let removed=0;
  for(const job of jobs){
    if(!job.isDirectory()||job.isSymbolicLink()||!UUID.test(job.name))continue;
    let claims;try{claims=await readdir(path.join(root,job.name),{withFileTypes:true})}catch{continue;}
    for(const claim of claims){
      if(!claim.isDirectory()||claim.isSymbolicLink()||!UUID.test(claim.name))continue;
      const file=path.join(root,job.name,claim.name,'mcp-video-edit-source.mp4');
      try{const stat=await lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.mtimeMs<=now-maxAgeMs){await unlink(file);removed++;}}
      catch(error){if(error?.code!=='ENOENT')console.warn('Chưa xóa được một video nguồn tạm.');}
    }
  }
  return removed;
}
