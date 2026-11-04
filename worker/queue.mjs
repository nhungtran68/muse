// PostgREST can represent an empty composite as an object whose fields are all
// null. Truthiness does not tell us whether the RPC actually claimed a job.
function claimedJob(value){
  if(value==null)return null;
  if(Array.isArray(value)){
    if(value.length===0)return null;
    if(value.length===1)return claimedJob(value[0]);
    throw Error('Claim RPC returned multiple jobs; refusing another claim.');
  }
  if(typeof value!=='object')throw Error('Claim RPC returned an invalid job.');
  if(value.id==null||value.id==='')return null;
  if(typeof value.id!=='string')throw Error('Claim RPC returned an invalid job ID.');
  return value;
}

export async function claimNextBrandJob(call,args){
  const current=claimedJob(await call('claim_brand_job_v3',args));
  if(current)return current;
  return claimedJob(await call('claim_brand_job_v2',args));
}
