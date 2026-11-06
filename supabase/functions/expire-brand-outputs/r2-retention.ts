import type {RetentionClaim} from './retention.ts';

export type MediaProviders={storage_provider:string|null;reference_storage_provider:string|null};
export type R2Removal=(input:{jobId:string;claim:string;bucket:string;paths:string[]})=>Promise<void>;

export async function deleteDueR2Outputs(job:RetentionClaim,providers:MediaProviders,remove:R2Removal){
  const groups:Array<{bucket:string;paths:string[]}>=[];
  if(providers.storage_provider==='r2'){
    const paths=[...new Set([job.final_path,...job.scene_paths.map(scene=>scene.path)].filter((path):path is string=>Boolean(path)))];
    if(paths.length)groups.push({bucket:'brand-videos',paths});
  }
  if(providers.reference_storage_provider==='r2'&&job.reference_path)groups.push({bucket:'brand-references',paths:[job.reference_path]});
  const failures:Array<{bucket:string;error:unknown}>=[];
  for(const group of groups){
    try{await remove({jobId:job.job_id,claim:job.retention_claim_token,bucket:group.bucket,paths:group.paths});}
    catch(error){failures.push({bucket:group.bucket,error});}
  }
  return {ok:failures.length===0,failures};
}
