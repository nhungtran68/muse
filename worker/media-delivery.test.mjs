import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverNextVideo} from './media-delivery.mjs';

const delivery = {
  id: 'job-123', claim: 'claim', group_id: '123456',
  final_path: 'owner/job-123/final.mp4', storage_provider: 'r2',
  expires_at: '2099-01-01T00:00:00Z'
};

function fixture(options = {}) {
  const calls = [];
  const client = {rpc: async (name, args) => {
    calls.push([name,args]);
    return {data: name === 'claim_zalo_delivery' ? delivery : true};
  }};
  return {calls, run: override => deliverNextVideo({
    client, workerId: 'worker', leaseToken: 'lease', accessToken: '', bridgeUrl: '',
    bridgeToken: '', ...options, ...override
  })};
}

test('no configured destination does not claim a job', async () => {
  const f = fixture();
  assert.equal(await f.run(), 'not_configured');
  assert.deepEqual(f.calls, []);
});

test('bridge receives MP4 and a lost POST response is resolved by the saved receipt', async () => {
  const file = new Blob([new Uint8Array(4096)], {type:'video/mp4'});
  let starts = 0, key;
  const f = fixture({
    bridgeUrl:'http://127.0.0.1:3030', bridgeToken:'test-key',
    download:async (_client, params) => {
      assert.equal(params.path, delivery.final_path);
      return file;
    },
    fetcher:async (url, opts) => {
      assert.equal(opts.headers['x-bridge-token'], 'test-key');
      if (opts.method === 'POST') {
        starts++;
        assert.equal(url.pathname, '/api/send-video');
        assert.equal(opts.body, file);
        assert.equal(opts.headers['x-group-id'], delivery.group_id);
        key = opts.headers['x-job-id'];
        assert.match(key, /^[a-f0-9]{32}$/);
        throw Error('lost response');
      }
      assert.equal(url.pathname, `/api/videos/${key}/status`);
      return Response.json({ok:true,confirmed:true});
    }
  });
  assert.equal(await f.run(), 'sent');
  assert.equal(starts, 1);
  assert.equal(f.calls.at(-1)[1].p_state, 'sent');
});

test('OA rejects a successful HTTP response without a matching Zalo receipt', async () => {
  const f = fixture({
    accessToken: 'fake', sign: async () => 'https://storage.example/video.mp4',
    fetcher: async () => Response.json({error:0,data:{group_id:'other',message_id:'received'}})
  });
  assert.equal(await f.run(), 'uncertain');
  assert.equal(f.calls.at(-1)[1].p_detail, 'ZALO_RESPONSE_UNCONFIRMED');
});

test('OA sends the signed link intact and records a confirmed message', async () => {
  const url = 'https://storage.example/video.mp4?signature=unmodified';
  const f = fixture({
    accessToken: 'fake', sign: async () => url,
    fetcher: async (endpoint, opts) => {
      assert.equal(new URL(endpoint).hostname, 'openapi.zalo.me');
      const body = JSON.parse(opts.body);
      assert.equal(body.recipient.group_id, delivery.group_id);
      assert.ok(body.message.text.endsWith(url));
      return Response.json({error:0,data:{group_id:delivery.group_id,message_id:'confirmed'}});
    }
  });
  assert.equal(await f.run(), 'sent');
  assert.equal(f.calls.at(-1)[1].p_detail, 'confirmed');
});
