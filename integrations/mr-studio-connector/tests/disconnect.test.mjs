import test from 'node:test';
import assert from 'node:assert/strict';
import {createDisconnectHandler,createGrantRevoker} from '../worker/disconnect.mjs';
import {sealMemberSession} from '../worker/link-crypto.mjs';
const site='https://connector.test',userId='site-user',secret=new Uint8Array(32).fill(5);
async function fixture({revoke=async()=>true}={}){
 let envelope=await sealMemberSession({secret,userId,session:{access_token:'private-access',refresh_token:'private-refresh'}}),cleared=0;
 const store={withUserLock:async(_id,fn)=>fn({read:async()=>envelope,clear:async()=>{envelope=null;cleared++}})};
 const handler=createDisconnectHandler({siteOrigin:site,secret,resolveIdentity:async()=>userId,store,revoke});
 return {handler,get envelope(){return envelope},get cleared(){return cleared}};
}
const request=origin=>new Request(site+'/link/disconnect',{method:'POST',headers:{Origin:origin}});
test('explicit disconnect revokes and removes the encrypted local session',async()=>{let seen='';const f=await fixture({revoke:async token=>{seen=token;return true}});const r=await f.handler(request(site));assert.equal(r.status,200);assert.match(await r.text(),/thu hồi quyền/);assert.equal(seen,'private-access');assert.equal(f.envelope,null);assert.equal(f.cleared,1)});
test('failed revocation still removes local session and tells the truth',async()=>{const f=await fixture({revoke:async()=>{throw Error('provider down')}});const r=await f.handler(request(site));assert.equal(r.status,200);assert.match(await r.text(),/Chưa xác nhận/);assert.equal(f.envelope,null)});
test('cross-origin disconnect does not delete the session',async()=>{const f=await fixture();const r=await f.handler(request('https://evil.test'));assert.equal(r.status,403);assert.ok(f.envelope);assert.equal(f.cleared,0)});
test('provider revoke uses only the linked user token and configured client',async()=>{let seen;const revoke=createGrantRevoker({projectUrl:'https://project.example',publishableKey:'sb_publishable_test',clientId:'client-id',fetcher:async(url,opts)=>{seen={url:new URL(url),opts};return new Response(null,{status:204})}});assert.equal(await revoke('user-token'),true);assert.equal(seen.url.searchParams.get('client_id'),'client-id');assert.equal(seen.opts.headers.Authorization,'Bearer user-token');assert.equal(seen.opts.method,'DELETE')});
