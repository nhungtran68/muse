import test from 'node:test';
import assert from 'node:assert/strict';
import {MuseAdapterV2,museVideoRejection,summarizeMuseReply} from './muse-adapter-v2.mjs';
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

test('recognizes explicit Vietnamese refusals without requiring the words báo lỗi',()=>{
  for(const reply of [
    'Mình không thể tạo video theo yêu cầu này.',
    'Thời lượng 8 giây không được hỗ trợ trong lần tạo này.',
    'Mình chưa thể xuất file MP4.',
    'Tôi không tạo được video.',
    'Báo lỗi cho đoạn 1/3 GEN_0, mình không giao clip này: bản tạo ra đúng 10,0 giây và có track AAC, nhưng khung hình là 960x960 vuông, không phải dọc 9:16 như yêu cầu. Theo đúng chỉ dẫn của bạn, mình đã không tự cắt hay kéo giãn về 720x1280. Bạn có muốn mình thử lại một lần với mã mới không?',
    'I am unable to generate a video for this request.'
  ])assert.equal(museVideoRejection(reply),true,reply);
  for(const reply of ['Video đang được tạo, vui lòng chờ.','Nếu không hỗ trợ thời lượng, hãy báo lỗi.','If not supported, report an error.'])assert.equal(museVideoRejection(reply),false,reply);
  assert.equal(summarizeMuseReply('Trả tại https://example.com/private?token=secret\n'+ 'A'.repeat(50)), 'Trả tại [liên kết] [mã]');
});
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
