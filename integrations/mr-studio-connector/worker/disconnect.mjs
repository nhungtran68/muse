import {openMemberSession} from './link-crypto.mjs';

// Always remove local access on request. A provider-side revocation is only
// claimed after the provider confirms it; expired tokens may require the user
// to revoke the grant through Mr Studio's account settings separately.
export function createDisconnectHandler({siteOrigin,secret,resolveIdentity,store,revoke}){
  const site=new URL(siteOrigin);
  if(site.protocol!=='https:'||site.username||site.password||site.pathname!=='/'||site.search||site.hash||typeof resolveIdentity!=='function'||typeof store?.withUserLock!=='function'||typeof revoke!=='function')throw new Error('Invalid disconnect configuration');
  const headers={'cache-control':'no-store, private','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-type':'text/plain; charset=utf-8'};
  return async function disconnect(request){
    if(request.method!=='POST')return new Response('Phương thức không hợp lệ.',{status:405,headers});
    if(request.headers.get('origin')!==site.origin)return new Response('Yêu cầu không hợp lệ.',{status:403,headers});
    const userId=await resolveIdentity(request);if(typeof userId!=='string'||!userId)return new Response('Vui lòng đăng nhập.',{status:401,headers});
    try{
      const result=await store.withUserLock(userId,async lease=>{
        const envelope=await lease.read();if(!envelope)return {linked:false,revoked:false};
        let revoked=false;
        try{const session=await openMemberSession({secret,userId,envelope});revoked=await revoke(session.access_token)===true}catch{}
        await lease.clear();return {linked:true,revoked};
      });
      const message=!result.linked?'Tài khoản chưa được liên kết.':result.revoked?'Đã ngắt kết nối và thu hồi quyền truy cập.':'Đã xóa kết nối tại đây. Chưa xác nhận được việc thu hồi quyền tại Mr Studio. Hãy mở https://ai.ibeetool.com/oauth/connections để kiểm tra và thu hồi quyền ứng dụng.';
      return new Response(message,{status:200,headers});
    }catch{return new Response('Không thể ngắt kết nối lúc này. Hãy thử lại.',{status:503,headers})}
  };
}

export function createGrantRevoker({projectUrl,publishableKey,clientId,fetcher=fetch}){
  const project=new URL(projectUrl);
  if(project.protocol!=='https:'||project.username||project.password||project.pathname!=='/'||project.search||project.hash||!String(publishableKey).startsWith('sb_publishable_')||!clientId)throw new Error('Invalid revocation configuration');
  return async accessToken=>{
    if(typeof accessToken!=='string'||!accessToken)return false;
    const url=new URL('/auth/v1/user/oauth/grants',project);url.searchParams.set('client_id',clientId);
    const response=await fetcher(url,{method:'DELETE',headers:{apikey:publishableKey,Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(8000)});
    return response.ok;
  };
}
