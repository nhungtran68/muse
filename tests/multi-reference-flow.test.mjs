import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {installedBrowserExecutable} from '../worker/muse-adapter.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const owner='20000000-0000-4000-8000-000000000002',jobId='aaaaaaaa-0000-4000-8000-000000000010';
const port=4378,api='http://127.0.0.1:4379';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const token=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:owner,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})}.test`;
const json=body=>({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'},body:JSON.stringify(body)});

test('five photos in the composer create one job and upload five separate files',async t=>{
  const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'local-test-anon-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>vite.kill());
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local site did not start')),30000);vite.stdout.on('data',data=>{if(data.toString().includes('Local:')){clearTimeout(timer);resolve();}});vite.on('exit',code=>reject(Error('Local site stopped: '+code)));});
  const browser=await chromium.launch({headless:true,...(installedBrowserExecutable()?{executablePath:installedBrowserExecutable()}:{})});t.after(()=>browser.close());
  const context=await browser.newContext(),page=await context.newPage(),calls=[];
  let job=null;
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===`http://127.0.0.1:${port}`)return route.continue();
    if(url.origin!==api)return route.abort();
    if(request.method()==='OPTIONS')return route.fulfill(json({}));
    if(url.pathname==='/auth/v1/token')return route.fulfill(json({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,user:{id:owner,email:'one@example.test',aud:'authenticated',role:'authenticated'}}));
    if(url.pathname==='/rest/v1/profiles')return route.fulfill(json({id:owner,email:'one@example.test',role:'member',approved:true}));
    if(url.pathname==='/rest/v1/app_settings')return route.fulfill(json({id:true,enabled:true,daily_limit:30}));
    if(url.pathname==='/rest/v1/video_modes')return route.fulfill(json([{seconds:10}]));
    if(url.pathname==='/rest/v1/brand_jobs')return route.fulfill(json(job?[job]:[]));
    if(url.pathname==='/rest/v1/rpc/submit_video_with_distribution'){
      const args=request.postDataJSON();calls.push({kind:'submit',args});
      job={id:jobId,user_id:owner,content:args.p_content,creation_mode:args.p_mode,status:'uploading',reference_path:`${owner}/${jobId}/reference`,reference_sha256:args.p_reference_sha256,reference_storage_provider:'supabase',storage_provider:'supabase',scene_count:1,scene_seconds:10,created_at:new Date().toISOString(),brand_scenes:[]};
      return route.fulfill(json(job));
    }
    if(url.pathname==='/rest/v1/rpc/set_job_reference_images'){
      const hashes=request.postDataJSON().p_hashes;
      job.reference_images=hashes.map((sha256,index)=>({path:`${owner}/${jobId}/reference${index?`-${index+1}`:''}`,sha256}));
      calls.push({kind:'configure',count:hashes.length});return route.fulfill(json(job));
    }
    if(url.pathname.startsWith('/storage/v1/object/brand-references/')&&request.method()==='POST'){
      calls.push({kind:'upload',path:url.pathname,bytes:request.postDataBuffer().length});return route.fulfill(json({Key:'reference'}));
    }
    if(url.pathname==='/rest/v1/rpc/queue_brand_job'){
      calls.push({kind:'queue'});job.status='queued';return route.fulfill(json(job));
    }
    return route.fulfill(json({message:'Unmocked route: '+url.pathname}));
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#auth-email').fill('one@example.test');await page.locator('#auth-password').fill('test-password-123');await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#create-form').waitFor();
  const files=await page.evaluate(async()=>Promise.all(['#f00','#0f0','#00f','#ff0','#0ff'].map(async(color,index)=>{
    const canvas=document.createElement('canvas');canvas.width=100;canvas.height=100;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,100,100);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    return {name:`photo-${index+1}.png`,mimeType:'image/png',buffer:[...new Uint8Array(await blob.arrayBuffer())]};
  })));
  await page.locator('#reference').setInputFiles(files.map(file=>({...file,buffer:Buffer.from(file.buffer)})));
  await page.waitForFunction(()=>document.querySelector('#image-processing-status')?.dataset.state==='ready');
  assert.match(await page.locator('#image-processing-status').innerText(),/5 ảnh độc lập/);
  assert.equal(await page.locator('#reference-file-list span').count(),5);
  assert.equal(await page.locator('#reference-previews img').count(),5);
  await page.locator('#content').fill('Tạo video giới thiệu vườn cây, dùng năm ảnh tham chiếu này.');
  await page.locator('.create-button').click();
  await page.waitForFunction(()=>document.querySelector('#notice')?.textContent?.includes('Đã gửi một yêu cầu hoàn chỉnh'));
  assert.deepEqual(calls.map(call=>call.kind),['submit','configure','upload','upload','upload','upload','upload','queue']);
  assert.equal(calls[1].count,5);
  for(let index=0;index<5;index++){
    assert.ok(calls[index+2].path.endsWith(index?`/reference-${index+1}`:'/reference'));
    assert.ok(calls[index+2].bytes>1000);
  }
  assert.equal(calls[0].args.p_reference_sha256.length,64);
});
