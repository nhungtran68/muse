import test from 'node:test';
import assert from 'node:assert/strict';
import {deleteDueR2Outputs} from '../supabase/functions/expire-brand-outputs/r2-retention.ts';
const job={job_id:'job',user_id:'owner',final_path:'owner/job/final.mp4',reference_path:'owner/job/reference',scene_paths:[{scene_index:1,path:'owner/job/final.mp4'}],retention_claim_token:'claim',retention_attempt:1};
test('R2 cleanup groups only due R2 objects and deduplicates a shared scene/final path',async()=>{
 const calls=[];const result=await deleteDueR2Outputs(job,{storage_provider:'r2',reference_storage_provider:'supabase'},async value=>calls.push(value));
 assert.equal(result.ok,true);assert.deepEqual(calls,[{jobId:'job',claim:'claim',bucket:'brand-videos',paths:['owner/job/final.mp4']}]);
});
test('a failed R2 deletion is reported for retry without blocking another due bucket',async()=>{
 const calls=[];const result=await deleteDueR2Outputs(job,{storage_provider:'r2',reference_storage_provider:'r2'},async value=>{calls.push(value.bucket);if(value.bucket==='brand-videos')throw Error('temporary');});
 assert.equal(result.ok,false);assert.deepEqual(calls,['brand-videos','brand-references']);assert.equal(result.failures.length,1);
});
test('legacy Supabase-only jobs never call R2 deletion',async()=>{
 const result=await deleteDueR2Outputs(job,{storage_provider:'supabase',reference_storage_provider:'supabase'},async()=>assert.fail());assert.equal(result.ok,true);
});
