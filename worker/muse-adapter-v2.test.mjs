import test from 'node:test';
import assert from 'node:assert/strict';
import {MuseAdapterV2,museVideoRejection,summarizeMuseReply} from './muse-adapter-v2.mjs';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from './muse-adapter.mjs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

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

test('recognizes explicit Vietnamese refusals without requiring the words báo lỗi',()=>{
  for(const reply of [
    'Mình không thể tạo video theo yêu cầu này.',
    'Thời lượng 8 giây không được hỗ trợ trong lần tạo này.',
    'Mình chưa thể xuất file MP4.',
    'Tôi không tạo được video.',
    'Mình không thể đọc tệp video đính kèm.',
    'Mình không chỉnh sửa được video này.',
    'Mình không thể truy cập ảnh tham chiếu.',
    'Đường dẫn /mnt/data/portrait.png không tồn tại.',
    'Báo lỗi cho đoạn 1/3 GEN_0, mình không giao clip này: bản tạo ra đúng 10,0 giây và có track AAC, nhưng khung hình là 960x960 vuông, không phải dọc 9:16 như yêu cầu. Theo đúng chỉ dẫn của bạn, mình đã không tự cắt hay kéo giãn về 720x1280. Bạn có muốn mình thử lại một lần với mã mới không?',
    'I am unable to generate a video for this request.'
  ])assert.equal(museVideoRejection(reply),true,reply);
  for(const reply of ['Video đang được tạo, vui lòng chờ.','Nếu không hỗ trợ thời lượng, hãy báo lỗi.','If not supported, report an error.','Nội dung yêu cầu: “không thể truy cập ảnh tham chiếu”.','Bạn kiểm tra nếu không thể truy cập ảnh tham chiếu.'])assert.equal(museVideoRejection(reply),false,reply);
  assert.equal(summarizeMuseReply('Trả tại https://example.com/private?token=secret\n'+ 'A'.repeat(50)), 'Trả tại [liên kết] [mã]');
});
function draftFixture({navigate = url => url, bubbles = () => 0} = {}) {
  const {adapter, page} = fixture();
  const visited = [];
  let current = 'https://muse.ai/';
  page.url = () => current;
  page.goto = async url => {
    visited.push(url);
    current = navigate(url);
  };
  page.getByRole = () => assert.fail('Opening a clean composer must not depend on the chat sidebar');
  page.locator = selector => {
    assert.equal(selector, '.hatch-chat-groupable-bubble');
    return {count: async () => bubbles(current)};
  };
  adapter.assertConnected = async () => {};
  adapter.composer = () => ({waitFor: async () => {}, inputValue: async () => ''});
  adapter.draftSettleMs = 0;
  return {adapter, page, visited};
}

test('opens a fresh home composer even when Muse has no chat sidebar', async () => {
  const {adapter, page, visited} = draftFixture();
  assert.deepEqual(await adapter.beginJob({id:'fixture'}), {state:'creating'});
  assert.deepEqual(visited, ['https://muse.ai/']);
  assert.equal(page.url(), 'https://muse.ai/');
});

test('falls back to the new chat route when the home page redirects into an existing chat', async () => {
  const {adapter, visited} = draftFixture({navigate: url => url.endsWith('/thread/new')
    ? url : 'https://muse.ai/thread/12345678-1234-1234-1234-123456789abc'});
  assert.deepEqual(await adapter.beginJob({id:'fixture'}), {state:'creating'});
  assert.deepEqual(visited, ['https://muse.ai/','https://muse.ai/thread/new']);
});

test('does not use a draft route that still shows another conversation', async () => {
  const {adapter} = draftFixture({bubbles: () => 1});
  await assert.rejects(adapter.beginJob({id:'fixture'}), {
    code:'MUSE_NEW_CHAT_UNAVAILABLE',
    retryable:true
  });
});

test('does not type a new job if Muse leaves its blank draft after opening it', async () => {
  const {adapter,page} = draftFixture();
  await adapter.beginJob({id:'fixture'});
  await page.goto('https://muse.ai/thread/12345678-1234-1234-1234-123456789abc');
  adapter.cleanComposer = () => assert.fail('No content should be sent to the wrong conversation');
  const job = {id:'12345678-1234-1234-1234-123456789abc',scene_seconds:10};
  await assert.rejects(adapter.generateSceneV2(job,{index:1},null), {
    code:'MUSE_NEW_CHAT_UNAVAILABLE',
    retryable:true
  });
});

test('does not press Enter if the draft navigates during receipt persistence', async () => {
  const {adapter, page} = draftFixture();
  await adapter.beginJob({id:'fixture'});
  const job = {id:'12345678-1234-1234-1234-123456789abc',creation_mode:'video_free',scene_count:1,scene_seconds:null};
  const scene = {index:1,action:'single_free_video_request',prompt:'Test video',dialogue:''};
  adapter.sceneResponse = async () => ({requested:false,video:null});
  let value = '';
  adapter.cleanComposer = async () => ({
    fill: async text => { value = text; },
    inputValue: async () => value,
    press: async () => assert.fail('Must not submit into another conversation')
  });
  await assert.rejects(adapter.generateSceneV2(job,scene,null,{
    onBeforeSend: async () => { await page.goto('https://muse.ai/thread/12345678-1234-1234-1234-123456789abc'); }
  }), {code:'UNCERTAIN_SUBMISSION',retryable:false});
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

test('a saved receipt missing from chat is recoverable by polling only and never resubmitted', async () => {
  const {adapter}=fixture();
  const job={id:'12345678-1234-1234-1234-123456789abc',schema_version:2,scene_count:3,scene_seconds:10};
  const scene={index:1,generation:0};
  const receipt={key:'BRAND_12345678_1234_1234_1234_123456789abc_SCENE_1_GEN_0'};
  adapter.composerTimeoutMs=0;
  adapter.sceneResponse=async()=>({requested:false,video:null});
  adapter.cleanComposer=()=>assert.fail('A saved receipt must never be resubmitted');
  await assert.rejects(adapter.generateSceneV2(job,scene,null,{receipt}),error=>
    error.code==='SUBMISSION_NOT_FOUND'&&error.retryable===true&&error.message.includes('không gửi lại'));
});

test('free mode waits for the joined final video and never downloads an intermediate clip',async()=>{
 const {adapter}=fixture(),job={id:'12345678-1234-1234-1234-123456789abc',creation_mode:'video_free',schema_version:2,scene_count:1,scene_seconds:null,content:'Tạo video dài ba mươi giây.'};
 const scene={index:1,generation:0,prompt:job.content,action:'single_free_video_request'};
 const key='BRAND_12345678_1234_1234_1234_123456789abc_SCENE_1_GEN_0';
 let reads=0,clicked=[];
 adapter.sceneResponse=async(_key,options)=>{assert.equal(options.finalOnly,true);reads++;return {requested:true,busy:reads===1,mediaIdentity:reads===1?'intermediate':'final',video:{click:async()=>clicked.push(reads===1?'intermediate':'final'),dispose:async()=>{}}};};
 adapter.cleanComposer=async()=>assert.fail('A saved request must not be resubmitted');adapter.assertConnected=async()=>{};
 adapter.downloadScene=async()=>({path:'joined-30s.mp4'});adapter.pollMs=1;adapter.mediaSettleMs=0;adapter.flexibleTimeoutMs=1000;
 const result=await adapter.generateSceneV2(job,scene,null,{receipt:{key}});assert.equal(result.path,'joined-30s.mp4');assert.deepEqual(clicked,['final']);
});

test('media selection skips uploaded references, stays in the matching reply, and picks the final joined video',async t=>{
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setContent(`<div class="hatch-chat-groupable-bubble bg-chat-user-bubble">KEY.<button aria-label="Mở hình ảnh" data-id="input"></button></div><div class="hatch-chat-groupable-bubble"><button aria-label="Mở video" data-id="clip"></button><button aria-label="Mở video" data-id="joined"></button><button aria-label="Mở hình ảnh" data-id="generated"></button></div><div class="hatch-chat-groupable-bubble bg-chat-user-bubble">OTHER.</div><div class="hatch-chat-groupable-bubble"><button aria-label="Mở video" data-id="another-user"></button></div><button>Stop task</button>`);
 const adapter=new MuseAdapterV2('','');adapter.requirePage=()=>page;
 const video=await adapter.sceneResponse('KEY',{kind:'video',finalOnly:true});assert.equal(await video.video.getAttribute('data-id'),'joined');assert.equal(video.busy,true);await video.video.dispose();
 const image=await adapter.sceneResponse('KEY',{kind:'image',finalOnly:true});assert.equal(await image.video.getAttribute('data-id'),'generated');await image.video.dispose();
 await page.locator('[data-id="generated"]').evaluate(node=>node.remove());
 const noImage=await adapter.sceneResponse('KEY',{kind:'image',finalOnly:true});assert.equal(noImage.video,null,'an uploaded reference is never returned as the generated image');
});

test('an image result downloads its rendered resource without opening the incompatible video dialog',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'muse-image-download-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64');
 const adapter=new MuseAdapterV2('',directory);adapter.requirePage=()=>({});
 const handle={evaluate:async()=>({url:'data:image/png;base64,'+bytes.toString('base64'),width:1,height:1}),click:async()=>assert.fail('Do not open the image viewer when the result resource is available')};
 const result=await adapter.downloadImage('image-result',handle);assert.match(result.path,/\.png$/);assert.deepEqual(await readFile(result.path),bytes);
});

test('a new single video request persists the Muse receipt before sending and marks it sent after acknowledgement',async()=>{
  const {adapter,page}=fixture(),job={id:'12345678-1234-1234-1234-123456789abc',schema_version:2,scene_seconds:10,content:'Kể về khu vườn vào buổi sớm.'};
  const scene={index:1,seconds:10,prompt:job.content,dialogue:'',action:'single_request'};
  let draft='',sent=0,beforeSend=0,submitted=0,responseReads=0;
  const input={async fill(value){draft=value;},async inputValue(){return draft;},async press(key){assert.equal(key,'Enter');sent++;}};
  adapter.cleanComposer=async()=>input;adapter.attachReference=async path=>assert.equal(path,'reference.png');
  adapter.sceneResponse=async()=>++responseReads===1?{requested:false,video:null}:{requested:true,video:{click:async()=>{},dispose:async()=>{}}};
  adapter.assertConnected=async()=>{};adapter.downloadScene=async()=>({path:'single.mp4'});adapter.pollMs=1;adapter.sceneTimeoutMs=1000;
  const result=await adapter.generateSceneV2(job,scene,'reference.png',{
    onBeforeSend:async receipt=>{beforeSend++;assert.ok(receipt.key.includes('SCENE_1_GEN_0'));},
    onSubmitted:async()=>{submitted++;}
  });
  assert.equal(result.path,'single.mp4');assert.equal(beforeSend,1);assert.equal(sent,1);assert.equal(submitted,1);
  assert.match(draft,/đúng một video dài 10 giây/);assert.match(draft,/không chia thành nhiều video/);
  assert.equal(page.url(),'https://muse.ai/thread/12345678-1234-1234-1234-123456789abc');
});

test('video edit never sends when source upload cannot be confirmed',async()=>{
 const {adapter}=fixture(),job={id:'12345678-1234-1234-1234-123456789abc',schema_version:2,creation_mode:'video_free',reference_kind:'video',reference_path:'source',scene_count:1,content:'Cắt video còn 5 giây'};
 const scene={index:1,prompt:job.content,action:'single_free_video_request'};let sends=0,receipts=0;
 adapter.sceneResponse=async()=>({requested:false,video:null});adapter.cleanComposer=async()=>({fill:async()=>{},press:async()=>sends++});
 adapter.attachVideoReference=async()=>{throw Object.assign(Error('upload unconfirmed'),{code:'MUSE_VIDEO_UPLOAD_UNCONFIRMED'})};
 await assert.rejects(adapter.generateSceneV2(job,scene,'reference.mp4',{onBeforeSend:async()=>receipts++}),{code:'MUSE_VIDEO_UPLOAD_UNCONFIRMED'});
 assert.equal(sends,0);assert.equal(receipts,0);
});
test('video upload waits for the named Muse thumbnail and an enabled send control',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'muse-video-upload-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'input.mp4');await writeFile(source,'test');
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const page=await browser.newPage();
 await page.setContent(`<div data-hatch-composer-chrome><input type="file"><button data-pel-click="chat_send_message" disabled>Gửi</button></div><script>
 const root=document.querySelector('[data-hatch-composer-chrome]');
 root.querySelector('input').addEventListener('change',()=>{setTimeout(()=>{const img=document.createElement('img');img.alt='input.mp4';img.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';root.append(img)},30);setTimeout(()=>root.querySelector('button').disabled=false,100)});
 </script>`);
 const adapter=new MuseAdapterV2('','');adapter.requirePage=()=>page;adapter.videoUploadTimeoutMs=2000;adapter.videoUploadPollMs=10;
 await adapter.attachVideoReference(source);assert.equal(await page.locator('button').isEnabled(),true);assert.equal(await page.getByRole('img',{name:'input.mp4'}).isVisible(),true);
});
test('video edit submits its attached source once after a durable receipt',async()=>{
 const {adapter}=fixture(),job={id:'12345678-1234-1234-1234-123456789abc',schema_version:2,creation_mode:'video_free',reference_kind:'video',reference_path:'source',scene_count:1,content:'Cắt video còn 5 giây'};
 const scene={index:1,prompt:job.content,action:'single_free_video_request'};let draft='',sends=0,attached=0,receipts=0,reads=0;
 const input={fill:async value=>draft=value,inputValue:async()=>draft,press:async()=>{assert.equal(receipts,1);sends++}};
 adapter.cleanComposer=async()=>input;adapter.attachReference=async()=>assert.fail('Video must not use the image uploader');adapter.attachVideoReference=async file=>{assert.equal(file,'reference.mp4');attached++};
 adapter.sceneResponse=async()=>++reads===1?{requested:false,video:null}:{requested:true,video:{click:async()=>{},dispose:async()=>{}}};
 adapter.assertConnected=async()=>{};adapter.downloadScene=async()=>({path:'edited.mp4'});adapter.pollMs=1;adapter.sceneTimeoutMs=1000;adapter.flexibleTimeoutMs=1000;adapter.mediaSettleMs=0;
 const result=await adapter.generateSceneV2(job,scene,'reference.mp4',{onBeforeSend:async()=>receipts++,onSubmitted:async()=>{}});
 assert.equal(result.path,'edited.mp4');assert.equal(attached,1);assert.equal(sends,1);assert.match(draft,/Cắt video còn 5 giây/);assert.match(draft,/VIDEO MP4 ĐÍNH KÈM/);
});

test('reports the scoped assistant refusal and never resends a recorded scene',async()=>{
  const {adapter}=fixture(),job={id:'12345678-1234-1234-1234-123456789abc',scene_seconds:10};
  const receipt={key:'BRAND_12345678_1234_1234_1234_123456789abc_SCENE_1_GEN_0'};
  adapter.sceneResponse=async()=>({requested:true,video:null,rejected:true,responseText:'Mình không thể tạo video theo yêu cầu này.'});
  adapter.cleanComposer=()=>assert.fail('Must not resend a recorded request');
  adapter.assertConnected=async()=>{};adapter.sceneTimeoutMs=1000;
  await assert.rejects(adapter.generateSceneV2(job,{index:1},null,{receipt}),error=>error.code==='MUSE_OUTPUT_REJECTED'&&error.retryable===false&&error.message.includes('Mình không thể tạo video'));
});

test('accepts an already received video even when the wait budget has expired',async()=>{
  const {adapter}=fixture(),job={id:'12345678-1234-1234-1234-123456789abc',scene_seconds:10};
  const receipt={key:'BRAND_12345678_1234_1234_1234_123456789abc_SCENE_1_GEN_0'};
  let disposed=false;
  adapter.sceneResponse=async()=>({requested:true,video:{click:async()=>{},dispose:async()=>{disposed=true;}}});
  adapter.cleanComposer=()=>assert.fail('Must not resend');adapter.assertConnected=async()=>{};
  adapter.downloadScene=async()=>({path:'ready.mp4'});adapter.sceneTimeoutMs=0;
  assert.deepEqual(await adapter.generateSceneV2(job,{index:1},null,{receipt}),{path:'ready.mp4'});
  assert.equal(disposed,true);
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
  await page.setContent(user('ONE') + assistant('Thời lượng này không được hỗ trợ.') + user('TWO') + card('two'));
  result=await adapter.sceneResponse('ONE');
  assert.equal(result.rejected,true);assert.equal(result.responseText,'Thời lượng này không được hỗ trợ.');
  await page.setContent(assistant('ONE. Create a video') + '<textarea>ONE. Create a video</textarea>');
  assert.equal((await adapter.sceneResponse('ONE')).requested, false);
});

test('storyboard reads only the assistant reply and never parses a repeated user JSON example',async t=>{
  const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});
  t.after(()=>browser.close());const page=await browser.newPage({offline:true});
  const adapter=new MuseAdapterV2('','');adapter.requirePage=()=>page;
  const marker='PLAN_JOB_T2_A0',example=JSON.stringify({id:marker,outline:'...'});
  const user=`<div class="hatch-chat-groupable-bubble bg-chat-user-bubble"><p>${example}</p></div>`;
  await page.setContent(user+'<div class="hatch-chat-groupable-bubble">Previous unrelated reply</div>'+user);
  assert.equal(await adapter.storyboardResponse(marker),'');
  const reply=JSON.stringify({id:marker,outline:['First scene','Second scene']});
  await page.locator('body').evaluate((body,text)=>{const message=document.createElement('div');message.className='hatch-chat-groupable-bubble';message.textContent=text;body.append(message);},reply);
  assert.equal(await adapter.storyboardResponse(marker),reply);
});

test('a request for more source data stops planning once and never submits a video or a repeated repair',async()=>{
  const {adapter,page}=fixture();
  const job={id:'12345678-1234-1234-1234-123456789abc',attempt:1,scene_count:3,scene_seconds:10,content:'Giới thiệu thương hiệu'};
  let sent=0,attached=0,draft='';
  adapter.cleanComposer=async()=>({fill:async text=>{draft=text;},inputValue:async()=>draft,press:async key=>{assert.equal(key,'Enter');sent++;}});
  adapter.attachReference=async()=>{attached++;};adapter.assertConnected=async()=>{};
  page.isClosed=()=>false;
  adapter.storyboardResponse=async marker=>JSON.stringify({id:marker,schema_version:2,status:'needs_input',scenes:[]});
  adapter.generateSceneV2=()=>assert.fail('An incomplete plan must not generate a video');
  await assert.rejects(adapter.storyboard(job,'reference.png'),{code:'CONTENT_INSUFFICIENT',retryable:false});
  assert.equal(sent,1);assert.equal(attached,1);
});

test('a long raw idea that Muse initially refuses is automatically condensed and retried as script-only',async()=>{
  const {adapter,page}=fixture();
  const job={id:'12345678-1234-1234-1234-123456789abc',attempt:1,schema_version:3,scene_count:1,scene_seconds:10,
    allow_summarize:true,content:'Gia đình không cần phải hoàn hảo. Hãy trân trọng thời gian bên cha mẹ, vợ chồng và con cái.'};
  let sent=0,attached=0,draft='';const prompts=[];
  adapter.cleanComposer=async()=>({fill:async text=>{draft=text;prompts.push(text);},inputValue:async()=>draft,press:async()=>{sent++;}});
  adapter.attachReference=async()=>{attached++;};adapter.assertConnected=async()=>{};page.isClosed=()=>false;
  adapter.storyboardResponse=async marker=>{
    if(sent===1)return JSON.stringify({id:marker,schema_version:3,status:'needs_shortening',suggested_scene_count:4,scenes:[]});
    return JSON.stringify({id:marker,schema_version:3,status:'ready',
      analysis:{topic:'Gia đình',message:'Trân trọng thời gian bên nhau',character:'Người trong ảnh',context:'Bối cảnh ảnh tham chiếu',purpose:'Chia sẻ thông điệp về gia đình'},
      outline:'Mở lời chia sẻ và kết bằng thông điệp trân trọng những điều bình dị.',
      scenes:[{index:1,seconds:10,prompt:'Nhân vật chia sẻ trực tiếp trước camera trong cùng bối cảnh ảnh.',
        dialogue:'Xin chào mọi người, hôm nay mình chia sẻ câu chuyện này thật gần gũi. Mong mọi người cùng lắng nghe và trân trọng những điều bình dị quanh mình nhé.',
        action:'Nhìn camera, mỉm cười nhẹ và nói tự nhiên.',source_quotes:['Gia đình không cần phải hoàn hảo']}]});
  };
  adapter.generateSceneV2=()=>assert.fail('Script planning must never start video generation');
  const result=await adapter.storyboard(job,'reference.png');
  assert.equal(result.scenes.length,1);assert.equal(sent,2);assert.equal(attached,1);
  assert.match(prompts[0],/TỰ ĐỘNG cô đọng/);assert.match(prompts[1],/Lượt trước chưa cô đọng nội dung/);
});
