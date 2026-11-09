import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createD1Store} from '../worker/d1-store.mjs';
import {createSessionManager} from '../worker/session-manager.mjs';
import {sealMemberSession} from '../worker/link-crypto.mjs';

function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../migrations/0001_link_sessions.sql',import.meta.url),'utf8'));let now=1000,n=0;
  const db={prepare(text){return{bind(...args){const stmt=sql.prepare(text);return{async run(){return {meta:{changes:stmt.run(...args).changes}}},async first(){return stmt.get(...args)||null}}}}}};
  const store=createD1Store({db,clock:()=>now,randomUUID:()=>`lock-${++n}`,leaseMs:30000});
  return {sql,store,setTime:value=>now=value};
}
test('only one owner lock exists and expired holders cannot write',async()=>{
 const f=fixture();let release,oldLease;const old=f.store.withUserLock('u',async lease=>{oldLease=lease;await new Promise(r=>release=r)});await new Promise(r=>setTimeout(r,0));
 await assert.rejects(f.store.withUserLock('u',async()=>{}),/đang được xử lý/);f.setTime(31001);
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
