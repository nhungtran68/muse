import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=4345,api='http://127.0.0.1:4346';
const owner='20000000-0000-4000-8000-000000000002';
const id='aaaaaaaa-0000-4000-8000-000000000010';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const token=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:owner,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})}.test`;
const refreshedToken=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:owner,exp:Math.floor(Date.now()/1000)+7200,aud:'authenticated',role:'authenticated',jti:'refreshed'})}.test`;
const json=(body,status=200)=>({status,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'},body:JSON.stringify(body)});
const lines=[
 'Xin chào mọi người, hôm nay mình kể về Đại Ngân Farm qua hình ảnh quen thuộc này, mình rất vui khi bạn ở đây cùng mình.',
 'Câu chuyện tiếp tục với một điều giản dị, mình mong mọi người lắng nghe và cảm nhận thật tự nhiên theo cách riêng của mình.',
 'Cuối cùng, mình cảm ơn mọi người đã ở lại nghe hết câu chuyện nhỏ này, hẹn gặp lại ở lần chia sẻ tiếp theo.'
];
const plan=count=>lines.slice(0,count).map((dialogue,i)=>({index:i+1,seconds:10,dialogue,prompt:'Same person, same background',action:'Small natural gesture',source_quotes:['Đại Ngân Farm']}));
test('browser separates script creation, editing, count change and explicit video approval',async t=>{
 const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'local-test-anon-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 t.after(()=>vite.kill());
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local test site did not start')),30000);vite.stdout.on('data',s=>{if(s.toString().includes('Local:')){clearTimeout(timer);resolve();}});vite.on('exit',code=>reject(Error('Local test site stopped: '+code)));});
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage();
 const calls=[];let job=null,failedSaves=0,acceptedToken=token,delayVideoDownload=0,delayedDownloads=0;
 let releaseApproval;const approvalGate=new Promise(resolve=>releaseApproval=resolve);
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
  if(url.origin!==api)return route.abort();
  if(request.method()==='OPTIONS')return route.fulfill(json({}));
  if(url.pathname==='/auth/v1/token')return route.fulfill(json({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:owner,email:'one@example.test',aud:'authenticated',role:'authenticated'}}));
  if(url.pathname==='/rest/v1/profiles')return route.fulfill(json({id:owner,email:'one@example.test',role:'member',approved:true}));
  if(url.pathname==='/rest/v1/app_settings')return route.fulfill(json({id:true,enabled:true,max_scenes:4,daily_limit:30,scene_seconds:10}));
  if(url.pathname==='/rest/v1/video_modes')return route.fulfill(json([{seconds:10}]));
  if(url.pathname==='/rest/v1/brand_jobs'){
   assert.equal(url.searchParams.get('user_id'),`eq.${owner}`);
   return route.fulfill(json(job?[{...job,brand_scenes:[]}]:[]));
  }
  if(url.pathname==='/rest/v1/rpc/submit_brand_job_v3'){
   const args=request.postDataJSON();calls.push({name:'submit',args});
   job={id,user_id:owner,content:args.p_content,scene_count:args.p_scene_count,scene_seconds:10,status:'uploading',schema_version:3,workflow_phase:'script',reference_path:`${owner}/${id}/reference`,script_revision:0,plan:[],created_at:new Date().toISOString()};
   return route.fulfill(json(job));
  }
  if(url.pathname.startsWith('/storage/v1/object/brand-references/')){
   if(request.method()==='POST')calls.push({name:'image-upload',contentType:request.headers()['content-type'],body:request.postData()||''});
   return route.fulfill(json({Key:'reference'}));
  }
  if(url.pathname.startsWith('/storage/v1/object/sign/brand-videos/'))return route.fulfill(json({signedURL:'/object/sign/brand-videos/final.mp4?token=local-test'}));
  if(url.pathname.includes('/brand-videos/')&&(url.pathname.startsWith('/storage/v1/object/')||url.pathname==='/storage/v1/object/sign/brand-videos/final.mp4')){
   if(!url.pathname.includes('/sign/')&&delayVideoDownload){delayedDownloads++;await new Promise(resolve=>setTimeout(resolve,delayVideoDownload));}
   return route.fulfill({status:200,contentType:'video/mp4',headers:{'access-control-allow-origin':'*'},body:Buffer.from([0,0,0,24,102,116,121,112,109,112,52,50])});
  }
  if(url.pathname==='/rest/v1/rpc/queue_brand_job'){
   calls.push({name:'queue'});job.status='script_queued';return route.fulfill(json(job));
  }
  if(url.pathname==='/rest/v1/rpc/retry_brand_job'){
   calls.push({name:'retry',args:request.postDataJSON()});
   if(job.status==='error')job.status='video_queued';
   return route.fulfill(json(job));
  }
  if(url.pathname==='/rest/v1/rpc/commit_brand_script_v3'){
   const args=request.postDataJSON();calls.push({name:args.p_submit?'video':'save',args});
   assert.equal(request.headers().authorization,`Bearer ${acceptedToken}`,'Editor must use the latest refreshed session token');
   if(!args.p_submit&&failedSaves>0){failedSaves--;return route.fulfill(json({message:'Simulated temporary save failure'},503));}
   if(args.p_submit)await approvalGate;
   assert.equal(args.p_scene_count,job.scene_count);
   assert.equal(args.p_revision,job.script_revision);
   const changed=job.plan.some((part,i)=>part.dialogue!==args.p_dialogues[i]);
   job.plan=job.plan.map((part,i)=>({...part,dialogue:args.p_dialogues[i]}));
   if(changed||args.p_submit)job.script_revision++;
   if(args.p_submit)job.status='video_queued';
   return route.fulfill(json(job));
  }
  if(url.pathname==='/rest/v1/rpc/replan_brand_script_v3'){
   const args=request.postDataJSON();calls.push({name:'replan',args});
   assert.equal(args.p_revision,job.script_revision);
   job.scene_count=args.p_scene_count;job.status='script_queued';job.plan=[];job.script_revision++;
   return route.fulfill(json(job));
  }
  return route.fulfill(json({message:'Unexpected local test route: '+url.pathname},404));
 });
 await page.goto(`http://127.0.0.1:${port}`);
 await page.locator('#auth-email').fill('one@example.test');await page.locator('#auth-password').fill('local-test-password-123');await page.locator('#auth-form button[type=submit]').click();
 await page.locator('#create-form').waitFor();
 await page.locator('#scene-count').selectOption('2');
 await page.locator('#content').fill('Giới thiệu Đại Ngân Farm bằng lời nói tự nhiên');
 await page.locator('#reference').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
 await page.waitForFunction(()=>document.querySelector('#image-processing-status')?.textContent.includes('Không đọc được ảnh'));
 assert.equal(await page.locator('#create-form .create-button').isDisabled(),true);
 const imageBytes=Buffer.from(await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=800;canvas.height=400;
  const context=canvas.getContext('2d');context.fillStyle='#234567';context.fillRect(0,0,800,400);context.fillStyle='#f1c40f';context.fillRect(320,100,160,200);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  return [...new Uint8Array(await blob.arrayBuffer())];
 }));
 await page.locator('#reference').setInputFiles({name:'reference-landscape.png',mimeType:'image/png',buffer:imageBytes});
 await page.waitForFunction(()=>document.querySelector('#image-processing-status')?.textContent.includes('Đã xử lý thành ảnh 720 × 1280'));
 await page.waitForFunction(()=>document.querySelector('#image-preview')?.complete&&document.querySelector('#image-preview')?.naturalWidth===720);
 assert.equal(await page.locator('#image-preview').evaluate(image=>[image.naturalWidth,image.naturalHeight].join('x')),'720x1280');
 await page.locator('#create-form .create-button').click();
 await page.locator('#jobs-list').getByText('Chờ tạo kịch bản').waitFor();
 assert.equal(calls.map(call=>call.name).join(','),'submit,image-upload,queue');
 const imageUpload=calls.find(call=>call.name==='image-upload');
 assert.match(imageUpload.contentType,/multipart\/form-data/);assert.match(imageUpload.body,/reference-9x16\.jpg/);assert.match(imageUpload.body,/image\/jpeg/);
 assert.equal(calls[0].args.p_scene_count,2);
 assert.match(await page.locator('#notice').innerText(),/Chưa bắt đầu tạo video/);
 job={...job,status:'script_ready',plan:plan(2),script_revision:1};
 await page.reload();await page.locator('.script-editor .script-dialogue').first().waitFor();
 assert.equal(await page.locator('.script-editor .script-dialogue').count(),2);
 assert.match(await page.locator('.script-total').innerText(),/20 giây/);
 const edited='Xin chào mọi người, lời thoại đầu này do chính khách hàng sửa lại, mình muốn nói chậm và tự nhiên trong video nha.';
 failedSaves=1;
 await page.locator('.script-dialogue').first().fill(edited);
 await page.locator('.script-note').filter({hasText:'Simulated temporary save failure'}).waitFor();
 assert.notEqual(job.plan[0].dialogue,edited);
 await page.locator('.save-script').click();
  await page.waitForFunction(()=>document.querySelector('.script-editor')?.dataset.revision==='2');
 assert.equal(job.plan[0].dialogue,edited);
 await page.locator('.script-scene-count').selectOption('3');
 assert.equal(await page.locator('.approve-script').isDisabled(),true);
 assert.match(await page.locator('.script-note').innerText(),/Cần tạo lại kịch bản/);
 await page.locator('.replan-script').click();
 await page.locator('#jobs-list').getByText('Chờ tạo kịch bản').waitFor();
 assert.equal(calls.at(-1).name,'replan');assert.equal(job.scene_count,3);
 assert.equal(calls.some(call=>call.name==='video'),false);
 job={...job,status:'script_ready',plan:plan(3),script_revision:job.script_revision+1};
 await page.reload();await page.locator('.script-editor .script-dialogue').first().waitFor();
 assert.equal(await page.locator('.script-dialogue').count(),3);
 acceptedToken=refreshedToken;
 await page.evaluate(async refreshed=>{
  const key=Object.keys(localStorage).find(name=>name.endsWith('-auth-token'));
  if(!key)throw Error('Missing fixture session');
  const refreshedSession={...JSON.parse(localStorage.getItem(key)),access_token:refreshed};
  localStorage.setItem(key,JSON.stringify(refreshedSession));
  const channel=new BroadcastChannel(key);
  channel.postMessage({event:'TOKEN_REFRESHED',session:refreshedSession});
  await new Promise(resolve=>setTimeout(resolve,100));channel.close();
 },refreshedToken);
 const lastEdit='Cuối cùng, đây là lời kết do khách hàng tự chỉnh sửa, mình cảm ơn mọi người đã nghe câu chuyện trọn vẹn hôm nay nha.';
 failedSaves=1;
 await page.locator('.script-dialogue').last().fill(lastEdit);
 await page.locator('.script-note').filter({hasText:'Simulated temporary save failure'}).waitFor();
 await page.locator('.approve-script').click();
 assert.equal(await page.locator('.script-dialogue').last().isDisabled(),true);
 assert.equal(await page.locator('.script-scene-count').isDisabled(),true);
 releaseApproval();
 await page.locator('#jobs-list').getByText('Chờ tạo video').waitFor();
 const approved=calls.find(call=>call.name==='video');
 assert.equal(approved.args.p_dialogues.length,3);
 assert.equal(approved.args.p_dialogues[2],lastEdit);
 assert.equal(approved.args.p_scene_count,3);
 assert.equal(job.status,'video_queued');
  job={...job,status:'done',final_path:`${owner}/${id}/claim/final.mp4`};
  await page.reload();await page.locator('.view-video').click();
  await page.locator('.video-slot video').waitFor();
  // A simultaneous job update forces refreshJobs while the MP4 is still being
  // downloaded. The player and download must survive that refresh.
  job={...job,updated_at:new Date(Date.now()+1000).toISOString()};
  delayVideoDownload=9000;
  const download=page.waitForEvent('download');await page.locator('.download-video').click();
  assert.equal((await download).suggestedFilename(),`muse-${id}.mp4`);
  assert.equal(delayedDownloads,1,'the actual MP4 download crossed a list refresh');
  assert.equal(await page.locator('.video-slot video').count(),1);
  job={...job,status:'error',workflow_phase:'video',error:'Muse chưa trả video đúng hạn; biên nhận được giữ để tiếp tục.',error_code:'MUSE_TIMEOUT',retryable:true,attempt:3,max_attempts:3,final_path:null};
  await page.reload();await page.locator('.job-error').getByText('Muse chưa trả video',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Tạo lại video'}).click();
  await page.locator('#jobs-list').getByText('Chờ tạo video').waitFor();
  assert.equal(calls.filter(call=>call.name==='retry').length,1,'the retry is submitted once and remains idempotent');
  assert.equal(calls.find(call=>call.name==='retry').args.p_id,id);
});
