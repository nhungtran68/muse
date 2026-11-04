import test from 'node:test';
import assert from 'node:assert/strict';
import {deleteJobOutputs} from '../supabase/functions/expire-brand-outputs/retention.ts';

const job={
  job_id:'aaaaaaaa-0000-4000-8000-000000000001',
  user_id:'20000000-0000-4000-8000-000000000002',
  final_path:'20000000-0000-4000-8000-000000000002/aaaaaaaa-0000-4000-8000-000000000001/final.mp4',
  reference_path:'20000000-0000-4000-8000-000000000002/aaaaaaaa-0000-4000-8000-000000000001/reference',
  scene_paths:[
    {scene_index:1,path:'20000000-0000-4000-8000-000000000002/aaaaaaaa-0000-4000-8000-000000000001/scenes/01.mp4'},
    {scene_index:2,path:'20000000-0000-4000-8000-000000000002/aaaaaaaa-0000-4000-8000-000000000001/scenes/02.mp4'},
  ],
  retention_attempt:1,
  retention_claim_token:'bbbbbbbb-0000-4000-8000-000000000001',
};

test('removes only this job’s final, scene, and reference paths by bucket',async()=>{
  const calls=[];
  const result=await deleteJobOutputs({async remove(bucket,paths){calls.push({bucket,paths});return {error:null};}},job);

  assert.deepEqual(result,{ok:true,failures:[]});
  assert.deepEqual(calls,[
    {bucket:'brand-videos',paths:[job.final_path,...job.scene_paths.map(scene=>scene.path)]},
    {bucket:'brand-references',paths:[job.reference_path]},
  ]);
});

test('continues cleanup after a bucket error and reports failure for retry',async()=>{
  const calls=[];
  const result=await deleteJobOutputs({async remove(bucket,paths){
    calls.push({bucket,paths});
    return {error:bucket==='brand-videos'?new Error('video storage unavailable'):null};
  }},job);

  assert.equal(calls.length,2,'reference removal is attempted even when video removal fails');
  assert.equal(result.ok,false);
  assert.equal(result.failures.length,1);
  assert.equal(result.failures[0].bucket,'brand-videos');
});

test('rejects a path belonging to another job before calling Storage',async()=>{
  const calls=[];
  const result=await deleteJobOutputs({async remove(bucket,paths){calls.push({bucket,paths});return {error:null};}},{
    ...job,
    scene_paths:[{scene_index:1,path:'30000000-0000-4000-8000-000000000003/cccccccc-0000-4000-8000-000000000003/scenes/01.mp4'}],
  });

  assert.equal(result.ok,false);
  assert.equal(result.failures[0].bucket,'validation');
  assert.equal(calls.length,0);
});

test('rejects traversal and malformed reference paths before calling Storage',async()=>{
  for(const override of [
    {final_path:`${job.user_id}/${job.job_id}/../someone-elses-file.mp4`},
    {reference_path:`${job.user_id}/${job.job_id}/reference-else`},
  ]){
    const calls=[];
    const result=await deleteJobOutputs({async remove(bucket,paths){calls.push({bucket,paths});return {error:null};}}, {...job,...override});
    assert.equal(result.ok,false);
    assert.equal(result.failures[0].bucket,'validation');
    assert.equal(calls.length,0);
  }
});

test('retry skips objects already removed by a partially successful prior attempt',async()=>{
  const scene=job.scene_paths[0].path,reference=job.reference_path;
  const existing=new Set([job.final_path,scene,job.scene_paths[1].path,reference]);
  const removeCalls=[];let attempt=0;
  const storage={
    async list(bucket,directory,search){
      const fullPath=`${directory}/${search}`;
      return {data:existing.has(fullPath)?[{name:search}]:[],error:null};
    },
    async remove(bucket,paths){
      removeCalls.push({attempt,bucket,paths:[...paths]});
      if(attempt===0&&bucket==='brand-videos'){
        existing.delete(job.final_path);
        return {error:new Error('partial remove')};
      }
      for(const path of paths)existing.delete(path);
      return {error:null};
    },
  };

  const first=await deleteJobOutputs(storage,job);
  assert.equal(first.ok,false,'partial removal must schedule the job for retry');
  attempt=1;
  const second=await deleteJobOutputs(storage,job);
  assert.equal(second.ok,true,'missing files from the prior attempt count as already removed');
  assert.deepEqual(removeCalls[2],{attempt:1,bucket:'brand-videos',paths:[scene,job.scene_paths[1].path]});
  assert.equal(removeCalls.length,3,'already-removed reference is not deleted again');
  assert.equal(existing.size,0);
});
