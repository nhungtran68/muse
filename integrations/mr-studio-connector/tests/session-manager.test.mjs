import test from 'node:test';
import assert from 'node:assert/strict';
import {sealMemberSession,openMemberSession} from '../worker/link-crypto.mjs';
import {createSessionManager} from '../worker/session-manager.mjs';
const secret=new Uint8Array(32).fill(3),userId='site-user',memberId='member-1';
async function fixture({expires=2000}={}){
 let value=await sealMemberSession({secret,userId,session:{access_token:'old-access',refresh_token:'old-refresh',expires_at:expires,member_id:memberId}}),calls=0,queued=Promise.resolve(),writes=0,failWrite=false,approved=true,pending=false;
 const store={withUserLock:async(_id,fn)=>{let release;const prev=queued;queued=new Promise(r=>release=r);await prev;try{return await fn({read:async()=>value,isRefreshPending:async()=>pending,beginRefresh:async()=>{pending=true},finishRefresh:async v=>{if(failWrite)throw Error('lost fence');writes++;value=v;pending=false},assertValid:async()=>{}})}finally{release()}}};
 const resolve=createSessionManager({secret,authBase:'https://project.example/auth/v1',clientId:'public-client',store,clock:()=>1000,verifyMember:async()=>({id:memberId,approved}),fetcher:async(_url,opts)=>{calls++;assert.equal(opts.body.get('refresh_token'),'old-refresh');await new Promise(r=>setTimeout(r,5));return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,token_type:'bearer'})}});
 return {resolve,get calls(){return calls},get writes(){return writes},get value(){return value},setFailWrite:()=>failWrite=true,setApproved:v=>approved=v};
}
test('concurrent calls serialize refresh and persist the rotated token once',async()=>{const f=await fixture();const [a,b]=await Promise.all([f.resolve(userId),f.resolve(userId)]);assert.equal(f.calls,1);assert.equal(f.writes,1);assert.equal(a.accessToken,'new-access');assert.equal(b.accessToken,'new-access');assert.equal((await openMemberSession({secret,userId,envelope:f.value})).refresh_token,'new-refresh')});
test('does not replay a refresh if fenced storage fails',async()=>{const f=await fixture();f.setFailWrite();await assert.rejects(f.resolve(userId),/lost fence/);await assert.rejects(f.resolve(userId),/liên kết lại/);assert.equal(f.calls,1)});
test('unapproved members cannot obtain a usable session',async()=>{const f=await fixture({expires:100000});f.setApproved(false);await assert.rejects(f.resolve(userId),/kiểm tra lại/);assert.equal(f.calls,0)});
