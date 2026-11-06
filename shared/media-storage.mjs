const DEFAULT_MEDIA_ORIGIN='https://muse-brand-studio.vercel.app';
const endpoint=origin=>`${String(origin||globalThis.location?.origin||DEFAULT_MEDIA_ORIGIN).replace(/\/$/,'')}/api/media`;

async function callGateway(client,token,origin,body){
  const accessToken=token||(await client.auth.getSession()).data.session?.access_token;
  if(!accessToken)throw Error('Phiên đăng nhập đã hết hạn.');
  const response=await fetch(endpoint(origin),{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(result.error||'Không kết nối được kho file.');
  return result;
}
export async function signedMediaUrl(client,{provider='supabase',bucket,path,jobId,token,origin,expiresIn=600}){
  if(provider!=='r2'){
    const result=await client.storage.from(bucket).createSignedUrl(path,expiresIn);if(result.error)throw result.error;
    return result.data.signedUrl;
  }
  const result=await callGateway(client,token,origin,{action:'get',bucket,path,jobId});return result.url;
}
export async function downloadMedia(client,options){
  if(options.provider!=='r2'){
    const result=await client.storage.from(options.bucket).download(options.path);if(result.error)throw result.error;
    return result.data;
  }
  const url=await signedMediaUrl(client,options),response=await fetch(url);
  if(!response.ok)throw Error('Không tải được file từ kho R2.');
  return response.blob();
}
export async function uploadMedia(client,{provider='supabase',bucket,path,jobId,token,origin,contentType,data}){
  if(provider!=='r2'){
    const result=await client.storage.from(bucket).upload(path,data,{contentType,upsert:false});if(result.error)throw result.error;
    return;
  }
  const size=data.size??data.byteLength;
  if(!Number.isSafeInteger(size)||size<1)throw Error('Không đọc được dung lượng file.');
  const body={bucket,path,jobId,contentType,size};
  const signed=await callGateway(client,token,origin,{action:'put',...body});
  const result=await fetch(signed.url,{method:'PUT',headers:{'Content-Type':contentType},body:data});
  if(!result.ok)throw Error('Không tải được file lên kho R2.');
  await callGateway(client,token,origin,{action:'finalize',...body});
}
