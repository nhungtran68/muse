import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {chromium,webkit} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),api='http://127.0.0.1:4363';
const owner='20000000-0000-4000-8000-000000000002';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const token=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:owner,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})}.test`;
const json=(body,status=200)=>({status,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'},body:JSON.stringify(body)});

for(const [engine,browserType,port] of [['Chromium',chromium,4362],['WebKit',webkit,4365]])test(`${engine}: one mobile tap saves each owner video and image using a prepared private link`,{skip:engine==='WebKit'&&!existsSync(webkit.executablePath())},async t=>{
 const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'local-test-anon-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 t.after(()=>vite.kill());
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local site did not start')),30000);vite.stdout.on('data',s=>{if(s.toString().includes('Local:')){clearTimeout(timer);resolve();}});vite.on('exit',code=>reject(Error('Local site stopped: '+code)));});
 const browser=await browserType.launch({headless:true,...(engine==='Chromium'&&installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,acceptDownloads:true});
 const page=await context.newPage(),now=Date.now(),requests=[];let failOnceFor='';
 const servers=[];
 for(const filePort of [4363,4364]){
  const server=createServer((req,res)=>{
   const url=new URL(req.url,`http://127.0.0.1:${filePort}`);
   const name=filePort===4364?`muse-${url.pathname.slice(1)}`:url.searchParams.get('download');
   res.writeHead(200,{'content-disposition':`attachment; filename="${name}"`,'content-type':'application/octet-stream'});
   res.end(filePort===4364?'R2 test media':'Supabase test video');
  });
  await new Promise(resolve=>server.listen(filePort,'127.0.0.1',resolve));servers.push(server);
 }
 t.after(async()=>{for(const server of servers)await new Promise(resolve=>server.close(resolve));});
 const jobs=[
  {id:'aaaaaaaa-0000-4000-8000-000000000011',creation_mode:'video_free',storage_provider:'r2',ext:'mp4'},
  {id:'aaaaaaaa-0000-4000-8000-000000000012',creation_mode:'image',storage_provider:'r2',ext:'png'},
  {id:'aaaaaaaa-0000-4000-8000-000000000013',creation_mode:'video_10s',storage_provider:'supabase',ext:'mp4'},
 ].map((job,index)=>({...job,user_id:owner,content:`Kết quả ${index+1}`,status:'done',scene_count:1,scene_seconds:10,brand_scenes:[],final_path:`${owner}/${job.id}/result.${job.ext}`,retention_status:'active',output_expires_at:new Date(now+3600000).toISOString(),created_at:new Date(now-index*1000).toISOString()}));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===`http://127.0.0.1:${port}`&&url.pathname==='/api/media'){
   const body=request.postDataJSON();requests.push({kind:'sign-r2',body});
   if(failOnceFor===body.jobId){failOnceFor='';return route.fulfill(json({error:'Kho tạm gián đoạn'},503));}
   const job=jobs.find(item=>item.id===body.jobId);
   return route.fulfill(json({url:`http://127.0.0.1:4364/${job.id}.${job.ext}`}));
  }
  if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
  if(url.origin==='http://127.0.0.1:4364'){
   requests.push({kind:'file',resourceType:request.resourceType()});
   return route.continue();
  }
  if(url.origin!==api)return route.abort();
  if(request.method()==='OPTIONS')return route.fulfill(json({}));
  if(url.pathname==='/auth/v1/token')return route.fulfill(json({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:owner,email:'one@example.test',aud:'authenticated',role:'authenticated'}}));
  if(url.pathname==='/rest/v1/profiles')return route.fulfill(json({id:owner,email:'one@example.test',role:'member',approved:true}));
  if(url.pathname==='/rest/v1/app_settings')return route.fulfill(json({id:true,enabled:true,daily_limit:30}));
  if(url.pathname==='/rest/v1/video_modes')return route.fulfill(json([{seconds:10}]));
  if(url.pathname==='/rest/v1/brand_jobs'){
   assert.equal(url.searchParams.get('user_id'),`eq.${owner}`);
   return route.fulfill(json(jobs));
  }
  if(url.pathname.startsWith('/storage/v1/object/sign/brand-videos/')){
   requests.push({kind:'sign-legacy'});
   return route.fulfill(json({signedURL:'/object/sign/legacy.mp4?token=fixture'}));
  }
  if(url.pathname==='/storage/v1/object/sign/legacy.mp4'){
   requests.push({kind:'file',resourceType:request.resourceType(),download:url.searchParams.get('download')});
   return route.continue();
  }
  return route.fulfill(json({message:'Unexpected fixture route'},404));
 });
 await page.goto(`http://127.0.0.1:${port}`);
 await page.locator('#auth-email').fill('one@example.test');await page.locator('#auth-password').fill('local-test-password-123');await page.locator('#auth-form button[type=submit]').tap();
 await page.locator('#jobs-list .job-card').first().waitFor({timeout:20000});
 for(const job of jobs){
  const link=page.locator(`.job-card[data-job-id="${job.id}"] .download-final`);
  await page.waitForFunction(id=>Boolean(document.querySelector(`.job-card[data-job-id="${id}"] .download-final[href]`)),job.id);
  assert.equal(await link.textContent(),'Tải xuống');
  assert.ok((await link.boundingBox()).height>=44,'the download target fits a fingertip');
  const [download]=await Promise.all([page.waitForEvent('download',{timeout:10000}).catch(error=>{console.error('download diagnostics',engine,job.ext,page.url(),JSON.stringify(requests));throw error;}),link.tap()]);
  assert.equal(download.suggestedFilename(),`muse-${job.id}.${job.ext}`);
  assert.equal((await fs.readFile(await download.path())).toString(),job.storage_provider==='r2'?'R2 test media':'Supabase test video');
 }
 assert.ok(requests.filter(x=>x.kind==='sign-r2').every(x=>x.body.download===true),'R2 download signatures request an attachment');
 assert.ok(requests.filter(x=>x.kind==='file').every(x=>x.resourceType!=='fetch'),'the browser downloads directly rather than buffering media in JavaScript');
 assert.equal(requests.find(x=>x.download)?.download,`muse-${jobs[2].id}.mp4`);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 failOnceFor=jobs[0].id;
 await page.reload();
 const retry=page.locator(`.job-card[data-job-id="${jobs[0].id}"] .download-final`);
 await retry.filter({hasText:'Thử tải lại'}).waitFor();await retry.tap();
 await page.waitForFunction(id=>Boolean(document.querySelector(`.job-card[data-job-id="${id}"] .download-final[href]`)),jobs[0].id);
 const [retried]=await Promise.all([page.waitForEvent('download',{timeout:10000}),retry.tap()]);
 assert.equal((await fs.readFile(await retried.path())).toString(),'R2 test media','a temporary signing error can be retried without regenerating the media');
});
