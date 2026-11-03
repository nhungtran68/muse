import test from 'node:test';
import assert from 'node:assert/strict';
import {MuseAdapterV2} from './muse-adapter-v2.mjs';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from './muse-adapter.mjs';

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

test('does not use a different chat after Muse redirects a saved conversation', async () => {
  const {adapter, page} = fixture();
  const saved = 'https://muse.ai/thread/12345678-1234-1234-1234-123456789abc';
  const navigate = page.goto;
  page.goto = () => navigate('https://muse.ai/thread/87654321-1234-1234-1234-123456789abc');
  await assert.rejects(adapter.beginJob({conversation_ref: {url: saved}}), {
    code: 'UNCERTAIN_CONVERSATION',
    retryable: false
  });
});

test('a timed-out retry keeps its receipt and picks up the matching result without resending', async () => {
  const {adapter} = fixture();
  const job = {id: '12345678-1234-1234-1234-123456789abc', scene_seconds: 5};
  const scene = {index: 1, generation: 1};
  const receipt = {key: 'BRAND_12345678_1234_1234_1234_123456789abc_SCENE_1_GEN_1'};
  let video = null;
  let clicks = 0;
  let historyLoading = false;
  adapter.sceneResponse = async key => {
    assert.equal(key, receipt.key);
    if (historyLoading) {
      historyLoading = false;
      return {requested: false, video: null};
    }
    return {requested: true, video};
  };
  adapter.cleanComposer = async () => assert.fail('The saved request must not be sent again');
  adapter.assertConnected = async () => {};
  adapter.downloadScene = async id => ({path: `${id}.mp4`});
  adapter.sceneTimeoutMs = 0;

  await assert.rejects(adapter.generateSceneV2(job, scene, null, {receipt}), {
    code: 'MUSE_TIMEOUT',
    retryable: true
  });

  video = {async click() { clicks++; }, async dispose() {}};
  historyLoading = true;
  adapter.pollMs = 1;
  adapter.sceneTimeoutMs = 1000;
  const result = await adapter.generateSceneV2(job, scene, null, {receipt});
  assert.equal(result.path, `${job.id}-1.mp4`);
  assert.equal(clicks, 1);
});

test('matches only the reply to the user request, even if Muse repeats the key or later requests have videos', async t => {
  const browser = await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});
  t.after(() => browser.close());
  const page = await browser.newPage({offline:true});
  const adapter = new MuseAdapterV2('', ''); adapter.requirePage = () => page;
  const user = key => `<div class="hatch-chat-groupable-bubble bg-chat-user-bubble"><span>You:</span><p>${key}. Create a video</p></div>`;
  const assistant = text => `<div class="hatch-chat-groupable-bubble">${text}</div>`;
  const card = id => `<button id="${id}" aria-label="Open video">Video</button>`;
  await page.setContent(user('ONE') + card('one') + assistant('ONE completed') + user('TWO') + card('two'));
  let result = await adapter.sceneResponse('ONE');
  assert.equal(result.requested, true); assert.equal(await result.video.getAttribute('id'), 'one'); await result.video.dispose();
  await page.setContent(user('ONE') + assistant('Still waiting') + user('TWO') + card('two'));
  result = await adapter.sceneResponse('ONE');
  assert.equal(result.video, null);
  await page.setContent(user('ONE') + assistant('Báo lỗi, mình không giao video này vì thời lượng sai.'));
  result = await adapter.sceneResponse('ONE');
  assert.equal(result.rejected, true);
  await page.setContent(assistant('ONE. Create a video') + '<textarea>ONE. Create a video</textarea>');
  assert.equal((await adapter.sceneResponse('ONE')).requested, false);
});
