import {spawn} from 'node:child_process';
import {stat,writeFile} from 'node:fs/promises';
import path from 'node:path';

function run(binary,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-6000);});
    child.once('error',reject);
    child.once('close',code=>code===0?resolve(stderr):reject(Error(`${binary} thất bại: ${stderr.slice(-1000)}`)));
  });
}

export async function probeVideo(file) {
  const output=await new Promise((resolve,reject)=>{
    const child=spawn('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name,width,height','-of','json',file],{windowsHide:true});
    let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
    child.once('error',reject);child.once('close',code=>code===0?resolve(stdout):reject(Error('ffprobe: '+stderr)));
  });
  const data=JSON.parse(output),video=data.streams?.find(stream=>stream.width&&stream.height);
  return {duration:Number(data.format?.duration),width:video?.width,height:video?.height,codec:video?.codec_name};
}

export async function checkMediaToolsAvailable() {
  try { await Promise.all([run('ffmpeg',['-version']),run('ffprobe',['-version'])]); }
  catch { throw Error('Thiếu FFmpeg hoặc ffprobe. Hãy cài cả hai và mở lại cửa sổ worker.'); }
}

export function validateScene(meta,seconds) {
  if(!Number.isFinite(meta.duration)||Math.abs(meta.duration-seconds)>.6)throw Error(`Video sai thời lượng: ${meta.duration} thay vì ${seconds} giây.`);
  if(!meta.width||!meta.height||Math.abs(meta.width/meta.height-9/16)>.025)throw Error(`Video không đúng khổ dọc 9:16: ${meta.width}x${meta.height}.`);
  if(meta.codec!=='h264')throw Error(`Video không phải H.264: ${meta.codec}.`);
}

export async function joinScenes(sceneFiles,target,expectedSeconds) {
  if(!sceneFiles.length)throw Error('Không có cảnh để ghép.');
  const list=path.join(path.dirname(target),'concat.txt');
  const entry=file=>`file '${file.replaceAll("'","'\\''").replaceAll('\\','/')}'`;
  await writeFile(list,sceneFiles.map(entry).join('\n'),'utf8');
  await run('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',list,'-c:v','libx264','-preset','veryfast','-crf','21','-c:a','aac','-b:a','160k','-movflags','+faststart',target]);
  const result=await probeVideo(target);
  if(Math.abs(result.duration-expectedSeconds)>1.5)throw Error(`Video ghép sai thời lượng: ${result.duration} thay vì ${expectedSeconds} giây.`);
  if((await stat(target)).size<1024)throw Error('Video ghép quá nhỏ.');
  return result;
}
