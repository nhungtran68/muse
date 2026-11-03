import {createClient} from '@supabase/supabase-js';
import {mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {createInterface as createQuestionInterface} from 'node:readline/promises';
import {MuseAdapter} from './muse-adapter.mjs';
import {joinScenes,probeVideo,validateScene} from './ffmpeg.mjs';
import {publishableKey,supabaseUrl} from './config.js';

const base=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.join(base,'data'),authFile=path.join(dataDir,'auth.json'),downloadsDir=path.join(dataDir,'downloads');
mkdirSync(dataDir,{recursive:true});
const authStorage={
  getItem:async key=>{try{const value=JSON.parse(readFileSync(authFile,'utf8'));return value.key===key?value.value:null;}catch{return null;}},
  setItem:async(key,value)=>writeFileSync(authFile,JSON.stringify({key,value}),{mode:0o600}),
  removeItem:async()=>{try{unlinkSync(authFile);}catch{}}
};
const supabase=createClient(supabaseUrl,publishableKey,{auth:{storage:authStorage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
const adapter=new MuseAdapter(path.join(dataDir,'muse-profile'),downloadsDir);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function hiddenPassword(){
  readline.emitKeypressEvents(process.stdin);
  return new Promise((resolve,reject)=>{
    if(!process.stdin.isTTY||!process.stdin.setRawMode)return reject(Error('Cần chạy trong cửa sổ lệnh tương tác.'));
    let value='';process.stdout.write('Mật khẩu quản trị (không hiển thị): ');
    process.stdin.setRawMode(true);process.stdin.resume();
    const end=error=>{process.stdin.off('keypress',key);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value);};
    const key=(char,event={})=>{
      if(event.ctrl&&event.name==='c')return end(Error('Đã hủy.'));
      if(event.name==='return'||event.name==='enter')return end();
      if(event.name==='backspace'){value=value.slice(0,-1);return;}
      if(char&&!event.ctrl&&!event.meta&&char.charCodeAt(0)>=32)value+=char;
    };
    process.stdin.on('keypress',key);
  });
}
async function adminLogin(){
  const current=await supabase.auth.getUser();let user=current.data.user;
  if(!user){
    const prompt=createQuestionInterface({input:process.stdin,output:process.stdout});
    let email;
    try{email=(await prompt.question('Email quản trị web: ')).trim();}
    finally{prompt.close();}
    if(!email)throw Error('Vui lòng nhập email quản trị web.');
    const password=await hiddenPassword();
    const signed=await supabase.auth.signInWithPassword({email,password});if(signed.error)throw signed.error;
    user=signed.data.user;
  }
  const profile=await supabase.from('profiles').select('role,approved').eq('id',user.id).single();
  if(profile.error||profile.data.role!=='admin'||!profile.data.approved){await supabase.auth.signOut();throw Error('Tài khoản này chưa có quyền quản trị.');}
  supabase.auth.startAutoRefresh();
  return user;
}
function checkImage(bytes){
  if(bytes.length>10*1024*1024||bytes.length<100)throw Error('Ảnh tham chiếu không hợp lệ.');
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes[0]===255&&bytes[1]===216)return 'jpg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
  throw Error('Ảnh tham chiếu sai định dạng.');
}
async function updateJob(id,patch){
  const result=await supabase.from('brand_jobs').update({...patch,updated_at:new Date().toISOString()}).eq('id',id);
  if(result.error)throw result.error;
}
async function heartbeat(){
  const result=await supabase.from('app_settings').update({worker_heartbeat:new Date().toISOString()}).eq('id',true);
  if(result.error)console.error('Không cập nhật được trạng thái worker:',result.error.message);
}

export async function processBrandJob(job,{client=supabase,muse=adapter,workRoot=downloadsDir}={}){
  const jobDir=path.join(workRoot,job.id);await mkdir(jobDir,{recursive:true});
  const downloaded=await client.storage.from('brand-references').download(job.reference_path);
  if(downloaded.error)throw downloaded.error;
  const bytes=Buffer.from(await downloaded.data.arrayBuffer()),ext=checkImage(bytes);
  const imagePath=path.join(jobDir,'reference.'+ext);await writeFile(imagePath,bytes);
  let plan=Array.isArray(job.plan)&&job.plan.length===job.scene_count?job.plan:null;
  if(!plan){
    plan=await muse.planScenes(job,imagePath);
    const planned=await client.from('brand_jobs').update({plan,status:'generating',error:null,updated_at:new Date().toISOString()}).eq('id',job.id);
    if(planned.error)throw planned.error;
    const rows=plan.map(scene=>({job_id:job.id,scene_index:scene.index,prompt:scene.prompt,status:'waiting'}));
    const inserted=await client.from('brand_scenes').upsert(rows,{onConflict:'job_id,scene_index'});if(inserted.error)throw inserted.error;
  }else{
    const resumed=await client.from('brand_jobs').update({status:'generating',error:null,updated_at:new Date().toISOString()}).eq('id',job.id);
    if(resumed.error)throw resumed.error;
  }
  const savedResult=await client.from('brand_scenes').select('scene_index,status,output_path').eq('job_id',job.id);
  if(savedResult.error)throw savedResult.error;
  const savedScenes=new Map(savedResult.data.map(scene=>[scene.scene_index,scene]));
  const paths=[];
  for(const scene of plan){
    const saved=savedScenes.get(scene.index);
    if(saved?.status==='done'&&saved.output_path){
      const stored=await client.storage.from('brand-videos').download(saved.output_path);
      if(stored.error)throw stored.error;
      const localPath=path.join(jobDir,`scene-${String(scene.index).padStart(2,'0')}.mp4`);
      await writeFile(localPath,Buffer.from(await stored.data.arrayBuffer()));
      const meta=await probeVideo(localPath);validateScene(meta,job.scene_seconds);
      paths.push(localPath);
      continue;
    }
    const marked=await client.from('brand_scenes').update({status:'generating'}).eq('job_id',job.id).eq('scene_index',scene.index);if(marked.error)throw marked.error;
    const output=await muse.generateScene(job,scene,imagePath);
    const meta=await probeVideo(output.path);validateScene(meta,job.scene_seconds);
    const storagePath=`${job.user_id}/${job.id}/scenes/${String(scene.index).padStart(2,'0')}.mp4`;
    const uploaded=await client.storage.from('brand-videos').upload(storagePath,await readFile(output.path),{contentType:'video/mp4',upsert:false});
    if(uploaded.error)throw uploaded.error;
    const completed=await client.from('brand_scenes').update({status:'done',output_path:storagePath,duration:meta.duration}).eq('job_id',job.id).eq('scene_index',scene.index);if(completed.error)throw completed.error;
    const progress=await client.from('brand_jobs').update({current_scene:scene.index,updated_at:new Date().toISOString()}).eq('id',job.id);if(progress.error)throw progress.error;
    paths.push(output.path);
    console.log(`Cảnh ${scene.index}/${job.scene_count} hoàn tất.`);
  }
  const joining=await client.from('brand_jobs').update({status:'joining',updated_at:new Date().toISOString()}).eq('id',job.id);if(joining.error)throw joining.error;
  const finalFile=path.join(jobDir,'final.mp4');
  await joinScenes(paths,finalFile,job.scene_count*job.scene_seconds);
  const finalPath=`${job.user_id}/${job.id}/final.mp4`;
  const finalUpload=await client.storage.from('brand-videos').upload(finalPath,await readFile(finalFile),{contentType:'video/mp4',upsert:false});if(finalUpload.error)throw finalUpload.error;
  const done=await client.from('brand_jobs').update({status:'done',final_path:finalPath,error:null,updated_at:new Date().toISOString()}).eq('id',job.id);if(done.error)throw done.error;
  return finalPath;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    await adminLogin();await adapter.waitForLogin();
    const recovered=await supabase.rpc('recover_orphaned_brand_jobs');
    if(recovered.error)throw recovered.error;
    console.log('Worker đã sẵn sàng. Giữ cửa sổ Muse và cửa sổ này mở.');
    let lastHeartbeat=0;
    while(true){
      if(Date.now()-lastHeartbeat>30000){await heartbeat();lastHeartbeat=Date.now();}
      const claim=await supabase.rpc('claim_next_brand_job');
      if(claim.error){console.error('Không lấy được hàng đợi:',claim.error.message);await sleep(10000);continue;}
      if(!claim.data?.id){await sleep(5000);continue;}
      const job=claim.data;console.log('Đang xử lý yêu cầu',job.id);
      try{await processBrandJob(job);console.log('Video hoàn tất:',job.id);}
      catch(error){console.error('Cần kiểm tra:',job.id,error.message);await updateJob(job.id,{status:'needs_review',error:error.message.slice(0,1000)}).catch(e=>console.error(e.message));}
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
