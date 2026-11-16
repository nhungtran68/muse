import test from 'node:test';
import assert from 'node:assert/strict';
import {syncZaloGroups} from './zalo-groups.mjs';

test('publishes only usable group IDs and names under the current worker lease', async () => {
  let posted;
  await syncZaloGroups({
    client:{rpc:async (name,args) => { posted = {name,args}; return {data:true}; }},
    bridgeUrl:'http://127.0.0.1:3333', bridgeToken:'fixture', workerId:'worker', leaseToken:'lease',
    fetcher:async (url, options) => {
      assert.equal(url.pathname,'/api/groups');
      assert.equal(options.redirect,'error');
      return Response.json({ok:true,groups:[
        {groupId:'12345',name:' Nhóm thử ',totalMember:8},
        {groupId:'invalid',name:'Không hợp lệ'}
      ]});
    }
  });
  assert.deepEqual(posted,{name:'publish_zalo_groups',args:{
    p_worker:'worker',p_token:'lease',p_groups:[{id:'12345',name:'Nhóm thử'}]
  }});
});

test('a failed or insecure bridge cannot publish an empty or forged catalog', async () => {
  const base = {
    client:{rpc:async () => assert.fail('Unexpected catalog update')},
    bridgeToken:'fixture', fetcher:async () => new Response(null,{status:503})
  };
  await assert.rejects(syncZaloGroups({...base,bridgeUrl:'http://127.0.0.1:3333'}),/UNAVAILABLE/);
  await assert.rejects(syncZaloGroups({...base,bridgeUrl:'http://bridge.test'}),/INVALID_ZALO_BRIDGE/);
});
