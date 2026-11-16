import {signedMediaUrl} from '../shared/media-storage.mjs';

const CHANNEL='zalo_group';
const trimError=value=>String(value||'').replace(/[\r\n]+/g,' ').slice(0,400);

// The webhook is server/worker-only. It should be an n8n/Make bridge or an
// official Zalo OA/GMF endpoint; never put an OA token in app_settings.
export async function deliverCompletedMedia({client,job,finalPath,token,origin,fetcher=globalThis.fetch}){
  const settings=await client.from('app_settings').select('send_outputs_to_zalo,zalo_group_id').eq('id',true).single();
  if(settings.error)throw settings.error;
  const target=String(settings.data?.zalo_group_id||'').trim();
  if(!settings.data?.send_outputs_to_zalo||!target)return {status:'disabled'};
  const webhook=String(process.env.ZALO_GROUP_WEBHOOK_URL||'').trim();
  if(!webhook)return {status:'not_configured',reason:'ZALO_GROUP_WEBHOOK_URL'};
  const claim=await client.rpc('claim_media_delivery',{p_job:job.id,p_channel:CHANNEL,p_target_id:target});
  if(claim.error)throw claim.error;
  if(claim.data!==true)return {status:'duplicate_or_in_flight'};
  try{
    const mediaUrl=await signedMediaUrl(client,{provider:job.storage_provider,bucket:'brand-videos',path:finalPath,jobId:job.id,token,origin,expiresIn:300,download:false});
    const response=await fetcher(webhook,{method:'POST',headers:{'Content-Type':'application/json',...(process.env.ZALO_GROUP_WEBHOOK_SECRET?{'X-MrStudio-Delivery-Secret':process.env.ZALO_GROUP_WEBHOOK_SECRET}:{})},body:JSON.stringify({event:'video.completed',job_id:job.id,target_id:target,media_url:mediaUrl,media_type:'video/mp4',expires_in:300,content:String(job.content||'').slice(0,200)})});
    if(!response.ok)throw Error(`Webhook trả về HTTP ${response.status}`);
    await client.rpc('finish_media_delivery',{p_job:job.id,p_channel:CHANNEL,p_target_id:target,p_ok:true});
    return {status:'sent',target_id:target};
  }catch(error){
    await client.rpc('finish_media_delivery',{p_job:job.id,p_channel:CHANNEL,p_target_id:target,p_ok:false,p_error:trimError(error.message)}).catch(()=>{});
    return {status:'failed',target_id:target,error:trimError(error.message)};
  }
}
