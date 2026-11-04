import test from 'node:test';
import assert from 'node:assert/strict';
import {claimNextBrandJob} from './queue.mjs';

const args={p_worker:'worker',p_token:'lease'};
function caller(responses){
  const calls=[];
  return {calls,async call(name,received){
    calls.push(name);assert.equal(received,args);
    assert.ok(responses.length,'Claimed more often than expected');
    const response=responses.shift();if(response instanceof Error)throw response;return response;
  }};
}

test('falls back to the legacy queue for every empty PostgREST composite shape',async()=>{
  for(const empty of [null,undefined,[],{id:null,status:null,user_id:null},[null]]){
    const job={id:'legacy-job',schema_version:2},probe=caller([empty,job]);
    assert.equal(await claimNextBrandJob(probe.call,args),job);
    assert.deepEqual(probe.calls,['claim_brand_job_v3','claim_brand_job_v2']);
  }
});

test('never claims the legacy queue after a version 3 job was claimed',async()=>{
  for(const response of [{id:'current-job',schema_version:3},[{id:'current-job',schema_version:3}]]){
    const probe=caller([response]),job=await claimNextBrandJob(probe.call,args);
    assert.equal(job.id,'current-job');assert.deepEqual(probe.calls,['claim_brand_job_v3']);
  }
});

test('returns null after both queues are empty without repeating a claim',async()=>{
  const probe=caller([{id:null},[]]);
  assert.equal(await claimNextBrandJob(probe.call,args),null);
  assert.deepEqual(probe.calls,['claim_brand_job_v3','claim_brand_job_v2']);
});

test('propagates RPC failures rather than hiding them with another claim',async()=>{
  const failedCurrent=caller([new Error('lease lost')]);
  await assert.rejects(claimNextBrandJob(failedCurrent.call,args),/lease lost/);
  assert.deepEqual(failedCurrent.calls,['claim_brand_job_v3']);
  const failedLegacy=caller([null,new Error('network failed')]);
  await assert.rejects(claimNextBrandJob(failedLegacy.call,args),/network failed/);
  assert.deepEqual(failedLegacy.calls,['claim_brand_job_v3','claim_brand_job_v2']);
});

test('does not claim again after an ambiguous or malformed claim response',async()=>{
  for(const response of [[{id:'one'},{id:'two'}],true,{id:42}]){
    const probe=caller([response]);
    await assert.rejects(claimNextBrandJob(probe.call,args));
    assert.deepEqual(probe.calls,['claim_brand_job_v3']);
  }
});
