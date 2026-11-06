import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=4352,api='http://127.0.0.1:4353';
const owner='20000000-0000-4000-8000-000000000002';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const token=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:owner,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})}.test`;
const json=(body,status=200,headers={})=>({status,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','access-control-expose-headers':'content-range',...headers},body:JSON.stringify(body)});

test('history pages three at a time and retention states survive reload without exposing expired media',async t=>{
  const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'local-test-anon-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>vite.kill());
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local test site did not start')),30000);vite.stdout.on('data',s=>{if(s.toString().includes('Local:')){clearTimeout(timer);resolve();}});vite.on('exit',code=>reject(Error('Local test site stopped: '+code)));});
  const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
  const page=await browser.newPage(),now=Date.now();
  const paths={
    active:`${owner}/aaaaaaaa-0000-4000-8000-000000000001`,deleting:`${owner}/aaaaaaaa-0000-4000-8000-000000000002`,
    overdue:`${owner}/aaaaaaaa-0000-4000-8000-000000000003`,expired:`${owner}/aaaaaaaa-0000-4000-8000-000000000004`,
    failed:`${owner}/aaaaaaaa-0000-4000-8000-000000000005`,
  };
  const jobs=[
    {id:'aaaaaaaa-0000-4000-8000-000000000001',user_id:owner,content:'Active video for the first member',scene_count:1,scene_seconds:10,status:'done',final_path:`${paths.active}/final.mp4`,reference_path:`${paths.active}/reference`,output_expires_at:new Date(now+45*60*1000).toISOString(),retention_status:'active'},
    {id:'aaaaaaaa-0000-4000-8000-000000000002',user_id:owner,content:'One scene expired while later files remain active',scene_count:2,scene_seconds:10,status:'done',final_path:`${paths.deleting}/final.mp4`,reference_path:`${paths.deleting}/reference`,reference_expires_at:new Date(now+35*60*1000).toISOString(),output_expires_at:new Date(now+30*60*1000).toISOString(),retention_status:'deleting',brand_scenes:[{scene_index:1,status:'done',output_path:`${paths.deleting}/scene-01.mp4`,output_expires_at:new Date(now-60_000).toISOString()},{scene_index:2,status:'done',output_path:`${paths.deleting}/scene-02.mp4`,output_expires_at:new Date(now+20*60*1000).toISOString()}]},
    {id:'aaaaaaaa-0000-4000-8000-000000000003',user_id:owner,content:'Expired timestamp awaiting server confirmation',scene_count:1,scene_seconds:10,status:'done',final_path:`${paths.overdue}/final.mp4`,reference_path:`${paths.overdue}/reference`,reference_expires_at:new Date(now-1000).toISOString(),output_expires_at:new Date(now-1000).toISOString(),retention_status:'active'},
    {id:'aaaaaaaa-0000-4000-8000-000000000004',user_id:owner,content:'Confirmed deleted output',scene_count:1,scene_seconds:10,status:'done',final_path:null,reference_path:null,output_expires_at:new Date(now-120_000).toISOString(),retention_status:'expired'},
    {id:'aaaaaaaa-0000-4000-8000-000000000005',user_id:owner,content:'Deletion retry pending',scene_count:1,scene_seconds:10,status:'done',final_path:`${paths.failed}/final.mp4`,reference_path:`${paths.failed}/reference`,reference_expires_at:new Date(now-180_000).toISOString(),output_expires_at:new Date(now-180_000).toISOString(),retention_status:'delete_failed'},
  ].map((job,index)=>({...job,created_at:new Date(now-index*1000).toISOString(),reference_expires_at:job.reference_expires_at||null,brand_scenes:job.brand_scenes||[]}));
  const historyQueries=[],referenceSignPaths=[],videoSignPaths=[];
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
    if(url.origin!==api)return route.abort();
    if(request.method()==='OPTIONS')return route.fulfill(json({}));
    if(url.pathname==='/auth/v1/token')return route.fulfill(json({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:owner,email:'one@example.test',aud:'authenticated',role:'authenticated'}}));
    if(url.pathname==='/auth/v1/logout')return route.fulfill(json({}));
    if(url.pathname==='/rest/v1/profiles')return route.fulfill(json({id:owner,email:'one@example.test',role:'member',approved:true}));
    if(url.pathname==='/rest/v1/app_settings')return route.fulfill(json({id:true,enabled:true,max_scenes:4,daily_limit:30,scene_seconds:10}));
    if(url.pathname==='/rest/v1/video_modes')return route.fulfill(json([{seconds:10}]));
    if(url.pathname==='/rest/v1/brand_jobs'){
      assert.equal(url.searchParams.get('user_id'),`eq.${owner}`,'history must stay scoped to the authenticated member');
      const range=request.headers().range||'';historyQueries.push({range,offset:url.searchParams.get('offset'),limit:url.searchParams.get('limit')});
      const match=range.match(/(\d+)-(\d+)/),start=match?Number(match[1]):Number(url.searchParams.get('offset')||0),end=match?Number(match[2]):start+Number(url.searchParams.get('limit')||jobs.length)-1;
      const data=jobs.slice(start,end+1);
      return route.fulfill(json(data,200,{'content-range':`${data.length?start:0}-${data.length?start+data.length-1:0}/${jobs.length}`}));
    }
    if(url.pathname.startsWith('/storage/v1/object/sign/brand-references/')){
      const encoded=url.pathname.slice('/storage/v1/object/sign/brand-references/'.length);referenceSignPaths.push(decodeURIComponent(encoded));
      return route.fulfill(json({signedURL:`${api}/fixture-reference.jpg`}));
    }
    if(url.pathname.startsWith('/storage/v1/object/sign/brand-videos/')){
      const encoded=url.pathname.slice('/storage/v1/object/sign/brand-videos/'.length);videoSignPaths.push(decodeURIComponent(encoded));
      return route.fulfill(json({signedURL:`${api}/fixture-video.mp4`}));
    }
    return route.fulfill(json({message:'Unexpected local test route: '+url.pathname},404));
  });

  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#auth-email').fill('one@example.test');await page.locator('#auth-password').fill('local-test-password-123');await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#jobs-list .job-card').first().waitFor({timeout:20000});
  assert.deepEqual(historyQueries,[{range:'',offset:'0',limit:'3'}],'initial history request must fetch only the newest three rows');
  assert.equal(await page.locator('#jobs-list .job-card').count(),3);
  assert.match(await page.locator('.retention-timer').first().innerText(),/^4[4-5] phút \d{2} giây$/,'countdown should derive from the server expiry timestamp');
  await page.reload();await page.locator('#jobs-list .job-card').first().waitFor({timeout:20000});
  assert.match(await page.locator('.retention-timer').first().innerText(),/^4[4-5] phút \d{2} giây$/,'reload should reconstruct the same countdown from persisted expiry');
  assert.deepEqual(referenceSignPaths,[jobs[0].reference_path,jobs[1].reference_path,jobs[0].reference_path,jobs[1].reference_path],'only active, unexpired references may be signed across reloads');
  assert.equal(await page.locator('#jobs-list .view-video').count(),3,'the unexpired final and later scene remain viewable while an earlier scene expires');
  assert.equal(await page.locator('#jobs-list .download-final').count(),2,'an expired scene must not disable the still-valid final video');
  const partialCard=page.locator(`.job-card[data-job-id="${jobs[1].id}"]`);
  assert.equal(await partialCard.locator('.view-scene').count(),1,'only the later, unexpired scene may be previewed');
  assert.match(await page.locator('#jobs-list').innerText(),/đang chờ máy chủ xác nhận xóa/);
  assert.match(await page.locator('#jobs-list').innerText(),/Một số file đã hết hạn; hệ thống đang xác nhận xóa/);

  await page.locator('#jobs-pagination .jobs-more').click();
  await page.locator('#jobs-list').getByText('Deletion retry pending').waitFor();
  assert.equal(await page.locator('#jobs-list .job-card').count(),5,'load more should append the remaining history rows');
  assert.deepEqual(historyQueries.slice(-1),[{range:'',offset:'0',limit:'6'}],'load more should request only the first six rows');
  assert.match(await page.locator('#jobs-list').innerText(),/Đã hết hạn – File đã được xóa/);
  assert.match(await page.locator('#jobs-list').innerText(),/Không xóa được một số file sau các lần thử lại/);
  assert.equal(await page.locator('#jobs-list .view-video').count(),3);
  assert.ok(referenceSignPaths.length>=2&&referenceSignPaths.every(filePath=>[jobs[0].reference_path,jobs[1].reference_path].includes(filePath)),'expired, failed, and overdue references never receive signed URLs');

  await page.locator('#jobs-pagination .jobs-collapse').click();
  await page.waitForFunction(()=>document.querySelectorAll('#jobs-list .job-card').length===3);
  assert.equal(await page.locator('#jobs-list .job-card').count(),3,'collapse returns the list to three rows');
  assert.deepEqual(historyQueries.slice(-1),[{range:'',offset:'0',limit:'3'}]);
  await page.locator('#jobs-list .view-video:not(.view-scene)').first().click();
  await page.locator('#jobs-list video').waitFor();
  assert.ok(videoSignPaths.includes(jobs[0].final_path)&&videoSignPaths.every(filePath=>[jobs[0].final_path,jobs[1].final_path].includes(filePath)),'only still-valid outputs can obtain signed preview or download URLs');

  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    const overflow=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:window.innerWidth}));
    assert.ok(overflow.document<=overflow.viewport,`no horizontal overflow at ${viewport.width}px: ${JSON.stringify(overflow)}`);
  }
});
