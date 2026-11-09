import {createD1Store} from './d1-store.mjs';
import {createLinkFlow} from './link-flow.mjs';
import {createSessionManager} from './session-manager.mjs';
import {createMemberContextFactory,createMemberVerifier} from './member-context.mjs';
import {createMcpHandler} from './mcp.mjs';

// This handler may only run behind the authenticated, owner-private Sites
// gateway, which supplies and protects the oai-authenticated-user-id header.
// It is not safe to expose this Worker directly or as a public Site.
const PROJECT='https://wqfzfduccteuycfrymbu.supabase.co';
const MEDIA='https://ai.ibeetool.com';
const PUBLISHABLE='sb_publishable_fcWEyspUJfQkEJ_EjkvqdA_bKEBIBQN';
const headers={'cache-control':'no-store, private','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
function identity(request){const id=request.headers.get('oai-authenticated-user-id');return typeof id==='string'&&id.length>0&&id.length<=256?id:null}
function decodeKey(value){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('Invalid encryption key');
  const binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'=');
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes.length!==32)throw new Error('Invalid encryption key');return bytes;
}
function build(env){
  if(!env.DB||!env.MR_SITE_ORIGIN||!env.MR_OAUTH_CLIENT_ID)throw new Error('Missing configuration');
  const secret=decodeKey(env.MR_LINK_KEY),store=createD1Store({db:env.DB}),verifyMember=createMemberVerifier({projectUrl:PROJECT,publishableKey:PUBLISHABLE});
  const config={secret,authBase:PROJECT+'/auth/v1',clientId:env.MR_OAUTH_CLIENT_ID,store,verifyMember};
  const link=createLinkFlow({...config,siteOrigin:env.MR_SITE_ORIGIN,resolveIdentity:identity});
  const resolveSession=createSessionManager(config);
  const memberContext=createMemberContextFactory({projectUrl:PROJECT,publishableKey:PUBLISHABLE,mediaOrigin:MEDIA,resolveSession});
  const mcp=createMcpHandler({siteOrigin:env.MR_SITE_ORIGIN,resolveSiteIdentity:identity,resolveMember:async request=>{const userId=identity(request);return userId?memberContext(userId):null}});
  return {link,mcp};
}
const page='<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kết nối Mr Studio</title><style>body{font:16px system-ui;background:#f4f6fc;color:#17213b;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px}main{max-width:440px;background:#fff;border:1px solid #dce2f2;border-radius:20px;padding:28px}p{line-height:1.6}button{background:#012bea;color:#fff;border:0;border-radius:10px;padding:14px 20px;font-weight:700}</style></head><body><main><h1>Kết nối Mr Studio</h1><p>Đăng nhập vào tài khoản Mr Studio và xem quyền truy cập trước khi cho phép liên kết. Sau đó, quay lại ChatGPT để sử dụng.</p><form method="post" action="/link/start"><button type="submit">Kết nối tài khoản</button></form></main></body></html>';
export default {
  async fetch(request,env){
    let services;try{services=build(env)}catch{return new Response('Kết nối chưa được cấu hình.',{status:503,headers})}
    const url=new URL(request.url);if(url.origin!==new URL(env.MR_SITE_ORIGIN).origin)return new Response('Yêu cầu không hợp lệ.',{status:400,headers});
    if(url.pathname==='/mcp')return services.mcp(request);
    const userId=identity(request);if(!userId)return new Response('Vui lòng đăng nhập.',{status:401,headers});
    if(url.pathname==='/link/start')return services.link.start(request);
    if(url.pathname==='/link/callback')return services.link.callback(request);
    if(url.pathname==='/'&&request.method==='GET')return new Response(page,{headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
    return new Response('Không tìm thấy trang.',{status:404,headers});
  }
};
