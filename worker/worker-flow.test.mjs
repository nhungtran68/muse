import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {processBrandJob,formatJobError} from './worker.mjs';
import {probeVideo} from './ffmpeg.mjs';

test('members receive a readable error while browser call logs remain in local diagnostics',()=>{
  const error=Error('locator.click: Timeout 30000ms exceeded.\nCall log:\n waiting for getByRole(...)');
  assert.match(formatJobError(error),/Các cảnh đã tải được giữ lại/);
  assert.doesNotMatch(formatJobError(error),/locator|getByRole|Call log|30000/);
  assert.equal(formatJobError(Error('Video sai thời lượng: 8 thay vì 10 giây.')),'Video sai thời lượng: 8 thay vì 10 giây.');
});

function memoryClient(job,initialScenes,clip){
  const tables={brand_jobs:[structuredClone(job)],brand_scenes:structuredClone(initialScenes)};
  const objects=new Map([['brand-videos/scene-one.mp4',clip]]);
  const image=Buffer.alloc(128);image.set([137,80,78,71,13,10,26,10]);
  const uploads=[];
  return {tables,uploads,from(table){
    let patch=null,filters=[];
    const query={
      select(){return query;},
      update(value){patch=value;return query;},
      eq(key,value){filters.push(row=>row[key]===value);return query;},
      async upsert(rows,{ignoreDuplicates}){
        for(const row of rows){
          const existing=tables[table].find(other=>other.job_id===row.job_id&&other.scene_index===row.scene_index);
          if(existing){if(!ignoreDuplicates)Object.assign(existing,row);}else tables[table].push(structuredClone(row));
        }
        return {error:null};
      },
      then(resolve,reject){
        try{const rows=tables[table].filter(row=>filters.every(filter=>filter(row)));if(patch)rows.forEach(row=>Object.assign(row,patch));resolve({data:structuredClone(rows),error:null});}
        catch(error){reject(error);}
      }
    };
    return query;
  },storage:{from(bucket){return {
    async download(key){const bytes=bucket==='brand-references'?image:objects.get(`${bucket}/${key}`);return bytes?{data:new Blob([bytes]),error:null}:{error:Error('Missing fixture object')};},
    async upload(key,bytes,options){objects.set(`${bucket}/${key}`,bytes);uploads.push({key,options});return {data:{path:key},error:null};}
  };}}};
}

test('resumes an interrupted second scene, preserves scene one and joins a 30-second MP4',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-worker-flow-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const samples=['green','blue','red'].map(color=>path.join(root,`${color}.mp4`));
  for(const [index,color] of ['green','blue','red'].entries())await new Promise((resolve,reject)=>{
    const child=spawn('ffmpeg',['-y','-v','error','-f','lavfi','-i',`color=c=${color}:s=720x1280:r=24:d=10`,'-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',samples[index]],{windowsHide:true});
    let stderr='';child.stderr.on('data',part=>stderr+=part);child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(stderr)));
  });
  const job={id:'59f9bb31-923f-4c71-981c-f7ff69e46866',user_id:'member-fixture',reference_path:'reference',scene_count:3,scene_seconds:10,current_scene:1,plan:[1,2,3].map(index=>({index,prompt:`Local fixture scene ${index}`}))};
  const saved=[{job_id:job.id,scene_index:1,prompt:job.plan[0].prompt,status:'done',duration:10,output_path:'scene-one.mp4'},{job_id:job.id,scene_index:2,prompt:job.plan[1].prompt,status:'generating'}];
  const client=memoryClient(job,saved,await readFile(samples[0]));
  const calls=[];
  const muse={planScenes(){throw Error('A saved plan must be reused');},async generateScene(received,scene,image,options){calls.push({index:scene.index,resumeOnly:options.resumeOnly});return {path:samples[scene.index-1]};}};
  const finalPath=await processBrandJob(job,{client,muse,workRoot:root});
  assert.deepEqual(calls,[{index:2,resumeOnly:true},{index:3,resumeOnly:false}]);
  assert.equal(client.tables.brand_scenes[0].output_path,'scene-one.mp4');
  assert.ok(client.tables.brand_scenes.every(scene=>scene.status==='done'));
  assert.equal(client.tables.brand_jobs[0].status,'done');
  assert.equal(client.tables.brand_jobs[0].current_scene,3);
  assert.equal(finalPath,`member-fixture/${job.id}/final.mp4`);
  assert.equal(client.uploads.length,3);
  const meta=await probeVideo(path.join(root,job.id,'final.mp4'));
  assert.ok(Math.abs(meta.duration-30)<0.6);
  assert.equal(meta.width,720);assert.equal(meta.height,1280);
  const duplicateClient=memoryClient(job,saved,await readFile(samples[0]));
  const repeatedVideo={async generateScene(){return {path:samples[0]};}};
  await assert.rejects(()=>processBrandJob(job,{client:duplicateClient,muse:repeatedVideo,workRoot:path.join(root,'duplicate')}),error=>error.code==='MUSE_DUPLICATE_VIDEO');
  assert.equal(duplicateClient.uploads.length,0);
  assert.notEqual(duplicateClient.tables.brand_jobs[0].status,'done');
});
