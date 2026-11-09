import test from 'node:test';
import assert from 'node:assert/strict';
import {createLinkState,readLinkState,sealMemberSession,openMemberSession} from '../worker/link-crypto.mjs';
const secret=new Uint8Array(32).fill(7),userId='site-user-1';
test('PKCE state is bound to identity, time-limited, and produces a matching challenge',async()=>{
  const created=await createLinkState({secret,userId,now:1000});
  const verifier=await readLinkState({secret,userId,state:created.state,now:1100});
  const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  assert.equal(created.challenge,challenge);
  await assert.rejects(readLinkState({secret,userId:'site-user-2',state:created.state,now:1100}));
  await assert.rejects(readLinkState({secret,userId,state:created.state,now:601001}));
  await assert.rejects(readLinkState({secret,userId,state:created.state,now:999}));
});
test('encrypted session rejects tampering and cannot be read by another identity',async()=>{
  const session={access_token:'access-secret',refresh_token:'refresh-secret'},envelope=await sealMemberSession({secret,userId,session});
  assert.ok(!envelope.includes(session.refresh_token));assert.deepEqual(await openMemberSession({secret,userId,envelope}),session);
  await assert.rejects(openMemberSession({secret,userId:'site-user-2',envelope}));
  const parts=envelope.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  await assert.rejects(openMemberSession({secret,userId,envelope:parts.join('.')}));
});
test('empty identity and weak encryption keys are rejected',async()=>{
  await assert.rejects(createLinkState({secret,userId:''}));
  await assert.rejects(createLinkState({secret:new Uint8Array(8),userId}));
});
