import {createLinkState,readLinkState,sealMemberSession} from './link-crypto.mjs';

// Preparatory flow only. resolveIdentity must derive the authenticated Site
// visitor from trusted platform context, not a client-supplied header.
// store.save must durably write encrypted data for that identity, atomically.
export function createLinkFlow({siteOrigin,authBase,clientId,secret,resolveIdentity,verifyMember,store,fetcher=fetch,clock=Date.now}){
  const site=new URL(siteOrigin),auth=new URL(authBase);
  if(site.protocol!=='https:'||auth.protocol!=='https:'||site.username||site.password||auth.username||auth.password||site.pathname!=='/'||site.search||site.hash||auth.search||auth.hash||!clientId||typeof resolveIdentity!=='function'||typeof verifyMember!=='function'||typeof store?.save!=='function')throw new Error('Invalid link configuration');
  const callback=new URL('/link/callback',site).href;
  const noStore={'Cache-Control':'no-store, private','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  const error=(text,status=400)=>new Response(text,{status,headers:{...noStore,'content-type':'text/plain; charset=utf-8'}});
  async function identity(request){const userId=await resolveIdentity(request);return typeof userId==='string'&&userId.length>0&&userId.length<=256?userId:null;}
  return {
    async start(request){
      if(request.method!=='POST')return error('Phương thức không hợp lệ.',405);
      if(request.headers.get('origin')!==site.origin)return error('Yêu cầu không hợp lệ.',403);
      const userId=await identity(request);if(!userId)return error('Vui lòng đăng nhập ChatGPT trước.',401);
      try{
        const {state,challenge}=await createLinkState({secret,userId,now:clock()});
        const target=new URL(`${auth.href.replace(/\/$/,'')}/oauth/authorize`);
        target.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:callback,scope:'email',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
        return new Response(null,{status:303,headers:{...noStore,Location:target.href}});
      }catch{return error('Không thể bắt đầu liên kết.',503)}
    },
    async callback(request){
      if(request.method!=='GET')return error('Phương thức không hợp lệ.',405);
      const userId=await identity(request);if(!userId)return error('Vui lòng đăng nhập ChatGPT và thử lại.',401);
      const url=new URL(request.url);if(url.origin!==site.origin||url.pathname!=='/link/callback')return error('Địa chỉ không hợp lệ.',400);
      const code=url.searchParams.get('code'),state=url.searchParams.get('state');
      if(!code||code.length>4096||!state||state.length>16000||url.searchParams.getAll('code').length!==1||url.searchParams.getAll('state').length!==1)return error('Yêu cầu liên kết không hợp lệ.');
      try{
        const verifier=await readLinkState({secret,userId,state,now:clock()});
        const tokenUrl=`${auth.href.replace(/\/$/,'')}/oauth/token`;
        const result=await fetcher(tokenUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,redirect_uri:callback,code_verifier:verifier}),signal:AbortSignal.timeout(10000)});
        if(!result.ok)throw new Error('Exchange failed');
        const session=await result.json();
        if(session.token_type?.toLowerCase()!=='bearer'||typeof session.expires_in!=='number'||session.expires_in<1||session.expires_in>86400)throw new Error('Invalid session');
        const member=await verifyMember(session.access_token);
        if(!member?.id||member.approved!==true)throw new Error('Member not approved');
        const envelope=await sealMemberSession({secret,userId,session:{access_token:session.access_token,refresh_token:session.refresh_token,expires_at:clock()+session.expires_in*1000,member_id:member.id}});
        await store.save(userId,envelope);
        return new Response(null,{status:303,headers:{...noStore,Location:new URL('/?linked=1',site).href}});
      }catch{return error('Không thể liên kết tài khoản. Hãy mở lại trang kết nối và thử lại.',400)}
    }
  };
}
