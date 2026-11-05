import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink,open} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import net from 'node:net';

export function runtimeDataDir(){
  return path.resolve(process.env.MUSE_WORKER_DATA_DIR || (process.platform==='win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(homedir(),'AppData','Local'),'MuseBrandWorker')
    : path.join(homedir(),'.local','share','muse-brand-worker')));
}

export function protectSession(value,decrypt=false){
  if(process.platform!=='win32')return Promise.reject(Error('Lưu phiên tự động cần Windows DPAPI.'));
  const script=`[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); $entropy=[Text.Encoding]::UTF8.GetBytes('MuseBrandWorker/session/v1'); `+(decrypt
    ? `$bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))`
    : `$bytes=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($bytes))`);
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let result='';const timer=setTimeout(()=>{child.kill();reject(Error('Windows chưa mã hóa được phiên đăng nhập.'));},15000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',s=>result+=s);
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(Error('Không mở được Windows DPAPI.'));});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve(result):reject(Error('Không đọc/ghi được phiên đăng nhập bằng tài khoản Windows hiện tại.'));});
    child.stdin.end(value);
  });
}

export function encryptedSessionStorage(directory){
  const file=key=>path.join(directory,createHash('sha256').update(key).digest('hex')+'.dpapi');
  return {
    async getItem(key){
      try{return await protectSession(await readFile(file(key),'utf8'),true);}
      catch(error){if(error.code==='ENOENT')return null;throw error;}
    },
    async setItem(key,value){
      const encrypted=await protectSession(value);
      await mkdir(directory,{recursive:true});
      const target=file(key),temp=target+'.'+randomUUID()+'.tmp';
      try{await writeFile(temp,encrypted,{mode:0o600});await rename(temp,target);}
      finally{await unlink(temp).catch(()=>{});}
    },
    async removeItem(key){await unlink(file(key)).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  };
}

export async function acquireInstanceLock(directory,name='worker'){
  await mkdir(directory,{recursive:true});
  const target=path.join(directory,name+'.lock'),owner=randomUUID();
  if(process.platform==='win32'){
    // The OS releases this pipe after a crash/reboot. A stale PID file cannot
    // race two new workers into opening the same Chrome profile.
    const address='\\\\.\\pipe\\MuseBrandWorker-'+createHash('sha256').update(path.resolve(directory).toLowerCase()+'/'+name).digest('hex').slice(0,24);
    const server=net.createServer(socket=>socket.end('MuseBrandWorker'));
    try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,resolve);});}
    catch(error){if(error.code==='EADDRINUSE')throw Object.assign(Error('Worker đã chạy. Không mở thêm một bản nữa.'),{code:'WORKER_ALREADY_RUNNING'});throw error;}
    try{await writeFile(target,JSON.stringify({pid:process.pid,owner,started_at:new Date().toISOString()}),{mode:0o600});}
    catch(error){server.close();throw error;}
    return async()=>{try{const current=JSON.parse(await readFile(target,'utf8'));if(current.owner===owner)await unlink(target);}finally{await new Promise(resolve=>server.close(resolve));}};
  }
  for(let attempt=0;attempt<2;attempt++){
    try{
      const handle=await open(target,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({pid:process.pid,owner,started_at:new Date().toISOString()}));}finally{await handle.close();}
      return async()=>{try{const current=JSON.parse(await readFile(target,'utf8'));if(current.owner===owner)await unlink(target);}catch(error){if(error.code!=='ENOENT')throw error;}};
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      let current;try{current=JSON.parse(await readFile(target,'utf8'));}catch{throw Object.assign(Error('Worker khác đang khởi động.'),{code:'WORKER_ALREADY_RUNNING'});}
      let alive=true;try{process.kill(current.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
      if(alive)throw Object.assign(Error('Worker đã chạy. Không mở thêm một bản nữa.'),{code:'WORKER_ALREADY_RUNNING'});
      await unlink(target).catch(e=>{if(e.code!=='ENOENT')throw e;});
    }
  }
  throw Error('Không khóa được phiên Worker.');
}
