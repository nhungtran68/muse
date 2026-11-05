import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {encryptedSessionStorage,acquireInstanceLock} from './runtime-state.mjs';
import {adminLoginV2} from './login-v2.mjs';
import {MuseAdapter} from './muse-adapter.mjs';

test('Windows session survives a new storage instance and never writes a clear token', {skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-auth-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const secret=JSON.stringify({refresh_token:'secret-'+Date.now(),name:'Đại Ngân'});
  await encryptedSessionStorage(root).setItem('admin',secret);
  const files=await readdir(root);assert.equal(files.length,1);
  assert.ok(!(await readFile(path.join(root,files[0]),'utf8')).includes('secret-'));
  assert.equal(await encryptedSessionStorage(root).getItem('admin'),secret);
  await encryptedSessionStorage(root).setItem('admin',secret+'-refreshed');
  assert.equal(await encryptedSessionStorage(root).getItem('admin'),secret+'-refreshed');
  await encryptedSessionStorage(root).removeItem('admin');assert.equal(await encryptedSessionStorage(root).getItem('admin'),null);
});

test('only one worker uses the profile; a dead process lock can recover',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'muse-lock-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const release=await acquireInstanceLock(root);
  await assert.rejects(()=>acquireInstanceLock(root),{code:'WORKER_ALREADY_RUNNING'});
  await release();await writeFile(path.join(root,'worker.lock'),JSON.stringify({pid:2147483647,owner:'old'}));
  const next=await acquireInstanceLock(root);await next();
});

test('unattended startup verifies the saved admin account without asking for a password',async()=>{
  let refreshed=false;
  const client={auth:{getSession:async()=>({data:{session:{}}}),getUser:async()=>({data:{user:{id:'admin'}}}),startAutoRefresh:()=>{refreshed=true;},signInWithPassword:()=>{throw Error('Must not prompt');}},from:()=>({select:()=>({eq:()=>({single:async()=>({data:{role:'admin',approved:true}})})})})};
  assert.deepEqual(await adminLoginV2(client,{interactive:false}),{id:'admin'});assert.equal(refreshed,true);
});

test('unattended startup stops safely if no admin session is available',async()=>{
  const client={auth:{getSession:async()=>({data:{session:null}})}};
  await assert.rejects(()=>adminLoginV2(client,{interactive:false}),{code:'ADMIN_LOGIN_REQUIRED'});
});

test('Muse authentication redirects do not abort login or submit anything',async()=>{
  let url='https://auth.meta.com/login',checks=0;
  const page={url:()=>url,isClosed:()=>false};
  const adapter=new MuseAdapter('','');adapter.page=page;adapter.open=async()=>page;
  adapter.assertConnected=async()=>{assert.equal(new URL(url).hostname,'muse.ai');checks++;};
  adapter.composer=()=>({isVisible:async()=>true});
  const timer=setTimeout(()=>{url='https://muse.ai/thread/new';},80);
  try{await adapter.waitForLogin({timeoutMs:2000});}finally{clearTimeout(timer);}
  assert.ok(checks>0);
});
