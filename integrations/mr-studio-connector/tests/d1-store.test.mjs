import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createD1Store} from '../worker/d1-store.mjs';
import {createSessionManager} from '../worker/session-manager.mjs';
import {sealMemberSession} from '../worker/link-crypto.mjs';

function fixture(options={}){
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../migrations/0001_link_sessions.sql',import.meta.url),'utf8'));let now=1000,n=0;
  const db={prepare(text){return{bind(...args){const stmt=sql.prepare(text);return{async run(){return {meta:{changes:stmt.run(...args).changes}}},async first(){return stmt.get(...args)||null}}}}}};
  const store=createD1Store({db,clock:()=>now,randomUUID:()=>`lock-${++n}`,leaseMs:30000,...options});
  return {sql,store,setTime:value=>now=value};
}
test('only one owner lock exists and expired holders cannot write',async()=>{
 const f=fixture({lockAttempts:1});let release,oldLease;const old=f.store.withUserLock('u',async lease=>{oldLease=lease;await new Promise(r=>release=r)});await new Promise(r=>setTimeout(r,0));
 await assert.rejects(f.store.withUserLock('u',async()=>{}),{code:'LOCK_BUSY'});f.setTime(31001);
 await f.store.withUserLock('u',async current=>{await current.replace('new-envelope');await assert.rejects(oldLease.replace('stale-envelope'))});release();await old;
 assert.equal(await f.store.withUserLock('u',lease=>lease.read()),'new-envelope');
});
test('failed refresh stays marked across requests and a new link clears it',async()=>{
 const f=fixture(),secret=new Uint8Array(32).fill(9),userId='u';
 const original=await sealMemberSession({secret,userId,session:{access_token:'old',refresh_token:'rotating',expires_at:2000,member_id:'member'}});await f.store.save(userId,original);let calls=0;
 const resolve=createSessionManager({secret,authBase:'https://project.example/auth/v1',clientId:'client',store:f.store,clock:()=>1000,verifyMember:async()=>({id:'member',approved:true}),fetcher:async()=>{calls++;throw Error('timeout')}});
 await assert.rejects(resolve(userId),/thử lại sau/);await assert.rejects(resolve(userId),/liên kết lại/);assert.equal(calls,1);
 await f.store.save(userId,original);assert.equal(await f.store.withUserLock(userId,lease=>lease.isRefreshPending()),false);
});
test('each user has independent encrypted state',async()=>{const f=fixture();await f.store.save('a','encrypted-a');await f.store.save('b','encrypted-b');assert.equal(await f.store.withUserLock('a',lease=>lease.read()),'encrypted-a');assert.equal(await f.store.withUserLock('b',lease=>lease.read()),'encrypted-b')});
test('concurrent calls wait for the D1 lock and rotate a token once',async()=>{
 const f=fixture({sleep:()=>new Promise(resolve=>setTimeout(resolve,5))}),secret=new Uint8Array(32).fill(9),userId='u';
 const original=await sealMemberSession({secret,userId,session:{access_token:'old',refresh_token:'rotating',expires_at:2000,member_id:'member'}});await f.store.save(userId,original);
 let calls=0,started;const begun=new Promise(resolve=>started=resolve);let finish;const pending=new Promise(resolve=>finish=resolve);
 const resolve=createSessionManager({secret,authBase:'https://project.example/auth/v1',clientId:'client',store:f.store,clock:()=>1000,verifyMember:async()=>({id:'member',approved:true}),fetcher:async()=>{calls++;started();await pending;return Response.json({access_token:'new',refresh_token:'new-refresh',expires_in:3600,token_type:'bearer'})}});
 const first=resolve(userId);await begun;const second=resolve(userId);await new Promise(resolve=>setTimeout(resolve,15));finish();
 const result=await Promise.all([first,second]);assert.equal(calls,1);assert.deepEqual(result.map(x=>x.accessToken),['new','new']);
});
test('lock contention stops after the configured bound without running the callback',async()=>{
 let waits=0,calls=0,release;const f=fixture({lockAttempts:3,sleep:async()=>{waits++}});
 const first=f.store.withUserLock('u',async()=>{await new Promise(resolve=>release=resolve)});await new Promise(resolve=>setTimeout(resolve,0));
 await assert.rejects(f.store.withUserLock('u',async()=>{calls++}),{code:'LOCK_BUSY'});assert.equal(waits,2);assert.equal(calls,0);release();await first;
});
