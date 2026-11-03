import test from 'node:test';
import assert from 'node:assert/strict';
import {MuseAdapterV2} from './muse-adapter-v2.mjs';

function fixture(){
  let current='https://muse.ai/thread/12345678-1234-1234-1234-123456789abc',panel=false;
  const page={url:()=>current,async goto(url){current=url;},async waitForURL(predicate){assert.ok(predicate(new URL(current)));},getByRole(role,{name}){
    assert.equal(role,'button');
    if(name.test('New side chat'))return {isVisible:async()=>panel,waitFor:async()=>assert.equal(panel,true),click:async()=>{current='https://muse.ai/thread/new';}};
    if(name.test('Tên cuộc trò chuyện Unread chatsOpen chat and side chats'))return {waitFor:async()=>{},click:async()=>{panel=true;}};
    throw Error('Unexpected control');
  }};
  const adapter=new MuseAdapterV2('','');adapter.requirePage=()=>page;adapter.closePreview=async()=>{};adapter.composer=()=>({waitFor:async()=>{}});
  return {adapter,page};
}
test('opens a new side chat even when the Chats label contains the previous title',async()=>{
  const {adapter,page}=fixture();assert.deepEqual(await adapter.beginJob({id:'fixture'}),{state:'creating'});
  assert.equal(new URL(page.url()).pathname,'/thread/new');
});
test('resumes only a valid saved chat and stops on an uncertain or unsafe URL',async()=>{
  const {adapter}=fixture(),url='https://muse.ai/thread/12345678-1234-1234-1234-123456789abc';
  assert.deepEqual(await adapter.beginJob({conversation_ref:{url}}),{url});
  await assert.rejects(adapter.beginJob({conversation_ref:{url:'https://muse.ai/'}}),/không hợp lệ/);
  await assert.rejects(adapter.beginJob({conversation_ref:{state:'creating'}}),{code:'UNCERTAIN_CONVERSATION'});
});
