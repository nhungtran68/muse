import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getControlDevice,createControlPoller} from './control-device.mjs';

function memoryStorage(){let value=null;return {getItem:async()=>value,setItem:async(_key,v)=>{value=v;}};}
test('device credentials are random and stable across reconnects',async()=>{
  const store=memoryStorage(),first=await getControlDevice(store,{create:true});
  assert.equal(first.secret.length,64);assert.deepEqual(await getControlDevice(store),first);
  const other=await getControlDevice(memoryStorage(),{create:true});assert.notEqual(other.secret,first.secret);
  assert.notEqual(createHash('sha256').update(first.secret).digest('hex'),first.secret);
});
test('duplicate start deliveries wake only once while acknowledgment can retry',async()=>{
  const store=memoryStorage();await getControlDevice(store,{create:true});let wakes=0,acks=0;
  const client={rpc:async name=>name==='muse_control_poll'?{data:{request_id:'request-1'}}:(acks++,{data:true})};
  const poller=createControlPoller({client,storage:store,readState:async()=> 'ready',wake:()=>wakes++});
  await poller.poll();await poller.poll();assert.equal(wakes,1);assert.equal(acks,2);
});
test('offline control and an unpaired device never interrupt the supervisor',async()=>{
  const store=memoryStorage();let calls=0;
  const poller=createControlPoller({client:{rpc:async()=>{calls++;throw Error('network');}},storage:store,readState:async()=> 'waiting_docker',wake:()=>{throw Error('unexpected wake');}});
  await poller.poll();assert.equal(calls,0);await getControlDevice(store,{create:true});await poller.poll();assert.equal(calls,1);
});
