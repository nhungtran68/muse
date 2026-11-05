import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=4345,api='http://127.0.0.1:4346';
const owner='20000000-0000-4000-8000-000000000002',id='aaaaaaaa-0000-4000-8000-000000000010';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const token=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:owner,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})}.test`;
const previewPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64');
const json=(body,status=200)=>({status,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'},body:JSON.stringify(body)});

test('browser sends one complete video request, retries a failed job safely and previews its result',async t=>{
 const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'local-test-anon-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 t.after(()=>vite.kill());
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local test site did not start')),30000);vite.stdout.on('data',s=>{if(s.toString().includes('Local:')){clearTimeout(timer);resolve();}});vite.on('exit',code=>reject(Error('Local test site stopped: '+code)));});
 const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage(),calls=[];
 if(process.env.UI_EVIDENCE_DIR)await page.setViewportSize({width:390,height:844});
 let job=null,isApproved=true,delayInitialList=true;
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
  if(url.origin!==api)return route.abort();
  if(request.method()==='OPTIONS')return route.fulfill(json({}));
  if(url.pathname==='/auth/v1/token')return route.fulfill(json({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:owner,email:'one@example.test',aud:'authenticated',role:'authenticated'}}));
  if(url.pathname==='/auth/v1/logout')return route.fulfill(json({}));
  if(url.pathname==='/rest/v1/profiles')return route.fulfill(json({id:owner,email:'one@example.test',role:'member',approved:isApproved}));
  if(url.pathname==='/rest/v1/app_settings')return route.fulfill(json({id:true,enabled:true,daily_limit:30}));
  if(url.pathname==='/rest/v1/video_modes')return route.fulfill(json([{seconds:10}]));
  if(url.pathname==='/rest/v1/brand_jobs'){
   assert.equal(url.searchParams.get('user_id'),`eq.${owner}`);
   if(delayInitialList){delayInitialList=false;await new Promise(resolve=>setTimeout(resolve,500));}
   return route.fulfill(json(job?[{...job,brand_scenes:job.scene? [job.scene]:[]}]:[]));
  }
  if(url.pathname==='/rest/v1/rpc/submit_single_video_job'){
   const args=request.postDataJSON();calls.push({name:'submit',args});
   job={id,user_id:owner,content:args.p_content,scene_count:1,scene_seconds:args.p_seconds,status:'uploading',schema_version:2,workflow_phase:'video',reference_path:`${owner}/${id}/reference`,reference_sha256:args.p_reference_sha256,plan:[{index:1,seconds:args.p_seconds,prompt:args.p_content,dialogue:'',action:'single_request'}],created_at:new Date().toISOString(),attempt:0,max_attempts:3,retryable:true,scene:{scene_index:1,prompt:args.p_content,dialogue:'',action:'single_request',planned_seconds:args.p_seconds,status:'waiting',submission_state:'not_sent',generation:0}};
   return route.fulfill(json(job));
  }
  if(url.pathname.startsWith('/storage/v1/object/brand-references/')&&request.method()==='POST'){
   calls.push({name:'image-upload',contentType:request.headers()['content-type']});return route.fulfill(json({Key:'reference'}));
  }
  if(url.pathname==='/rest/v1/rpc/queue_brand_job'){
   calls.push({name:'queue',args:request.postDataJSON()});job.status='queued';return route.fulfill(json(job));
  }
  if(url.pathname==='/rest/v1/rpc/retry_single_video_job'){
   calls.push({name:'retry',args:request.postDataJSON()});job.status='queued';job.error=null;job.error_code=null;job.scene={...job.scene,status:'waiting',submission_state:'not_sent',request_receipt:null,generation:job.scene.generation+1};return route.fulfill(json(job));
  }
  if(url.pathname.startsWith('/storage/v1/object/sign/brand-references/'))return route.fulfill(json({signedURL:'/object/sign/reference.png?token=local-test'}));
  if(url.pathname==='/storage/v1/object/sign/reference.png')return route.fulfill({status:200,contentType:'image/png',headers:{'access-control-allow-origin':'*'},body:process.env.UI_EVIDENCE_PNG?await fs.readFile(process.env.UI_EVIDENCE_PNG):previewPng});
  if(url.pathname.startsWith('/storage/v1/object/sign/brand-videos/'))return route.fulfill(json({signedURL:'/object/sign/final.mp4?token=local-test'}));
  if(url.pathname==='/storage/v1/object/sign/final.mp4')return route.fulfill({status:200,contentType:'video/mp4',headers:{'access-control-allow-origin':'*'},body:process.env.UI_EVIDENCE_VIDEO?await fs.readFile(process.env.UI_EVIDENCE_VIDEO):Buffer.from([0,0,0,24,102,116,121,112,109,112,52,50])});
  return route.fulfill(json({message:'Unexpected local test route: '+url.pathname},404));
 });
 await page.goto(`http://127.0.0.1:${port}`);
 await page.locator('#auth-email').fill('one@example.test');await page.locator('#auth-password').fill('local-test-password-123');await page.locator('#auth-form button[type=submit]').click();
 await page.locator('#create-form').waitFor();
 await page.locator('#jobs-list .empty').getByText('Đang tải video…').waitFor();
 await page.locator('#jobs-list').getByText('Chưa có video nào').waitFor();
 assert.equal(await page.locator('#scene-count').count(),0,'the new composer has no scene-count or multi-step controls');
 assert.equal(await page.getByRole('button',{name:/Tạo kịch bản/}).count(),0);
 if(process.env.UI_EVIDENCE_DIR){
  await fs.mkdir(process.env.UI_EVIDENCE_DIR,{recursive:true});
  await page.waitForTimeout(50);
  const mobileLayout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,sidebarOpen:document.querySelector('.sidebar').classList.contains('open'),sidebarRight:document.querySelector('.sidebar').getBoundingClientRect().right,sidebarTransform:getComputedStyle(document.querySelector('.sidebar')).transform}));
  assert.equal(mobileLayout.width,390);assert.equal(mobileLayout.scrollWidth,390);assert.equal(mobileLayout.sidebarOpen,false);assert.ok(mobileLayout.sidebarRight<=0,`the mobile navigation starts closed and does not cover the composer: ${JSON.stringify(mobileLayout)}`);
  assert.equal(await page.locator('#menu-toggle').isVisible(),true);
  await page.screenshot({path:path.join(process.env.UI_EVIDENCE_DIR,'mobile-390x844.png')});
  await page.keyboard.press('Tab');
  const firstMobileFocus=await page.evaluate(()=>({id:document.activeElement.id,outline:getComputedStyle(document.activeElement).outlineStyle}));
  assert.equal(firstMobileFocus.id,'menu-toggle','keyboard focus skips the hidden mobile navigation');assert.notEqual(firstMobileFocus.outline,'none','keyboard focus remains visible');
  const touchTargets=await page.evaluate(()=>['#menu-toggle','.attach-control','.create-button'].map(selector=>Math.round(document.querySelector(selector).getBoundingClientRect().height)));
  assert.ok(touchTargets.every(height=>height>=44),`mobile menu, image picker and send targets are easy to tap: ${touchTargets}`);
  await page.locator('#content').fill('Một ý tưởng cần được trình bày thật rõ ràng và tự nhiên. '.repeat(60));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390,'a long prompt does not create horizontal overflow');
  await page.locator('#content').fill('');
  await page.locator('#menu-toggle').click();assert.equal(await page.locator('.sidebar').evaluate(node=>node.classList.contains('open')),true);
  await page.locator('.sidebar .nav-item[href="#jobs"]').click();assert.equal(await page.locator('.sidebar').evaluate(node=>node.classList.contains('open')),false);
  await page.locator('#menu-toggle').click();await page.locator('.sidebar .nav-item[href="#home"]').click();
  assert.equal(await page.locator('.sidebar').evaluate(node=>node.classList.contains('open')),false);
  await page.setViewportSize({width:1440,height:900});
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),1440,'desktop layout has no horizontal overflow');
  await page.screenshot({path:path.join(process.env.UI_EVIDENCE_DIR,'desktop-1440x900.png')});
 }
 await page.locator('#content').fill('Tạo video giới thiệu khu vườn, có lời kể gần gũi và hình ảnh buổi sớm.');
 const imageBytes=Buffer.from(await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;const context=canvas.getContext('2d');context.fillStyle='#234567';context.fillRect(0,0,720,1280);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));return [...new Uint8Array(await blob.arrayBuffer())];
 }));
 await page.locator('#reference').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:imageBytes});
 await page.waitForFunction(()=>document.querySelector('#image-processing-status')?.dataset.state==='ready');
 if(process.env.UI_EVIDENCE_DIR){
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390,'the selected-image state fits the mobile screen');
  await page.screenshot({path:path.join(process.env.UI_EVIDENCE_DIR,'composer-ready-mobile-390x844.png')});
  await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(250);
 }
 await page.getByRole('button',{name:/Gửi/}).click();
 await page.locator('#jobs-list').getByText('Đang chờ').waitFor();
 assert.deepEqual(calls.map(call=>call.name),['submit','image-upload','queue']);
 assert.equal(calls[0].args.p_seconds,10);assert.equal(calls[0].args.p_content,'Tạo video giới thiệu khu vườn, có lời kể gần gũi và hình ảnh buổi sớm.');
 assert.equal(calls[0].args.p_request_key.length>0,true);
 assert.match(await page.locator('#notice').innerText(),/một yêu cầu hoàn chỉnh/);
 assert.equal(job.scene_count,1);assert.equal(job.plan.length,1);assert.equal(job.scene.action,'single_request');

 job={...job,status:'error',error:'Muse không giao video: tác vụ bị từ chối.',error_code:'MUSE_OUTPUT_REJECTED',retryable:true,scene:{...job.scene,status:'error',error:'Muse không giao video.',error_code:'MUSE_OUTPUT_REJECTED'}};
 await page.reload();await page.getByRole('button',{name:'Gửi lại video'}).waitFor();
 if(process.env.UI_EVIDENCE_DIR){await page.getByRole('button',{name:'Gửi lại video'}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.UI_EVIDENCE_DIR,'error-retry-1440x900.png')});}
 await page.getByRole('button',{name:'Gửi lại video'}).click();
 await page.locator('#jobs-list').getByText('Đang chờ').waitFor();
 assert.equal(calls.filter(call=>call.name==='retry').length,1,'one deliberate retry requeues the same job once');
 assert.equal(calls.find(call=>call.name==='retry').args.p_id,id);
 assert.equal(calls.filter(call=>call.name==='submit').length,1,'retry does not create a second job');

 job={...job,status:'done',final_path:`${owner}/${id}/final.mp4`,retention_status:'active',output_expires_at:new Date(Date.now()+3600000).toISOString()};
 await page.reload();await page.getByRole('button',{name:'Xem video'}).waitFor();await page.getByRole('button',{name:'Xem video'}).click();
 await page.locator('.video-slot video').waitFor();
 await page.locator('.job-thumbnail').evaluate(image=>image.decode());
 if(process.env.UI_EVIDENCE_VIDEO)await page.waitForFunction(()=>document.querySelector('.video-slot video')?.readyState>=2&&document.querySelector('.video-slot video')?.duration>0);
 if(process.env.UI_EVIDENCE_DIR)await page.screenshot({path:path.join(process.env.UI_EVIDENCE_DIR,'success-video-1440x900.png')});
 assert.equal(await page.locator('.video-slot video').count(),1,'completed output is displayed in the web app');
 assert.equal((await page.locator('.video-slot video').getAttribute('src')).includes('final.mp4'),true);
 isApproved=false;await page.locator('#signout').click();await page.locator('#auth-form').waitFor();
 await page.locator('#auth-email').fill('one@example.test');await page.locator('#auth-password').fill('local-test-password-123');await page.locator('#auth-form button[type=submit]').click();
 await page.getByRole('heading',{name:'Tài khoản đang chờ duyệt'}).waitFor();
 assert.equal(await page.locator('#create-form').count(),0,'unapproved accounts cannot access the video composer');
 if(process.env.UI_EVIDENCE_DIR)await page.screenshot({path:path.join(process.env.UI_EVIDENCE_DIR,'permission-pending-1440x900.png')});
});
