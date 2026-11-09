import {createClient as defaultCreateClient} from '@supabase/supabase-js';

function validateProject(projectUrl,publishableKey){
  const project=new URL(projectUrl);
  if(project.protocol!=='https:'||project.username||project.password||project.pathname!=='/'||project.search||project.hash||!String(publishableKey).startsWith('sb_publishable_'))throw new Error('Invalid project configuration');
  return project;
}
function userClient(project,key,token,createClient){
  return createClient(project.origin,key,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
}
export function createMemberVerifier({projectUrl,publishableKey,createClient=defaultCreateClient}){
  const project=validateProject(projectUrl,publishableKey);
  return async function verifyMember(accessToken){
    if(typeof accessToken!=='string'||!accessToken)return null;
    const client=userClient(project,publishableKey,accessToken,createClient);
    const check=await client.auth.getUser(accessToken);
    if(check.error||!check.data?.user?.id)return null;
    const id=check.data.user.id;
    const profile=await client.from('profiles').select('approved').eq('id',id).maybeSingle();
    if(profile.error||profile.data?.approved!==true)return null;
    return {id,approved:true};
  };
}

// Resource calls use only the member's verified session, never a service key.
export function createMemberContextFactory({projectUrl,publishableKey,mediaOrigin,resolveSession,createClient=defaultCreateClient,fetcher=fetch}){
  const project=validateProject(projectUrl,publishableKey),media=new URL(mediaOrigin);
  if(media.protocol!=='https:'||media.username||media.password||media.pathname!=='/'||media.search||media.hash||typeof resolveSession!=='function')throw new Error('Invalid member context configuration');
  return async function memberContext(userId){
    const session=await resolveSession(userId);
    if(!session?.accessToken||!session?.memberId)throw new Error('Cần liên kết tài khoản.');
    const client=userClient(project,publishableKey,session.accessToken,createClient);
    const check=await client.auth.getUser(session.accessToken);
    if(check.error||check.data?.user?.id!==session.memberId)throw new Error('Không thể xác minh tài khoản.');
    const profile=await client.from('profiles').select('approved').eq('id',session.memberId).maybeSingle();
    if(profile.error||profile.data?.approved!==true)throw new Error('Tài khoản chưa được duyệt.');
    const mediaGateway=async({jobId,path,token})=>{
      if(token!==session.accessToken)throw new Error('Invalid member session');
      const response=await fetcher(new URL('/api/media',media),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'get',bucket:'brand-videos',jobId,path,download:true}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('Không thể lấy kết quả.');
      const body=await response.json();let url;try{url=new URL(body.url)}catch{throw new Error('Không thể lấy kết quả.')}
      if(url.protocol!=='https:'||url.username||url.password)throw new Error('Không thể lấy kết quả.');
      return url.href;
    };
    return {client,accessToken:session.accessToken,mediaGateway};
  };
}
