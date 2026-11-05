import readline from 'node:readline';
import {createInterface} from 'node:readline/promises';

function hiddenPassword(){
  readline.emitKeypressEvents(process.stdin);
  return new Promise((resolve,reject)=>{
    if(!process.stdin.isTTY||!process.stdin.setRawMode)return reject(Error('Cần chạy trong cửa sổ dòng lệnh tương tác.'));
    let value='';process.stdout.write('Mật khẩu quản trị (không hiển thị): ');
    process.stdin.setRawMode(true);process.stdin.resume();
    const end=error=>{process.stdin.off('keypress',key);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value);};
    const key=(char,event={})=>{if(event.ctrl&&event.name==='c')return end(Error('Đã hủy.'));if(event.name==='return'||event.name==='enter')return end();if(event.name==='backspace'){value=value.slice(0,-1);return;}if(char&&!event.ctrl&&!event.meta&&char.charCodeAt(0)>=32)value+=char;};
    process.stdin.on('keypress',key);
  });
}
async function approvedAdmin(client,user){
  const profile=await client.from('profiles').select('role,approved').eq('id',user.id).single();
  if(profile.error)throw profile.error;
  if(profile.data?.role!=='admin'||!profile.data?.approved){await client.auth.signOut({scope:'local'});throw Object.assign(Error('Tài khoản này chưa có quyền quản trị.'),{code:'ADMIN_NOT_APPROVED'});}
  client.auth.startAutoRefresh();return user;
}
export async function adminLoginV2(client,{interactive=Boolean(process.stdin.isTTY)}={}){
  const existing=await client.auth.getSession();
  if(existing.data?.session){
    const verified=await client.auth.getUser();
    if(!verified.error&&verified.data?.user){
      const user=await approvedAdmin(client,verified.data.user);
      console.log('Đã dùng lại phiên quản trị được mã hóa trên máy này.');return user;
    }
    // Keep tokens on transient network failures; only clear a rejected session.
    if(verified.error&&(!verified.error.status||verified.error.status>=500))throw verified.error;
    await client.auth.signOut({scope:'local'});
  }else if(existing.error&&(!existing.error.status||existing.error.status>=500))throw existing.error;
  if(!interactive)throw Object.assign(Error('Cần đăng nhập quản trị một lần bằng 03-DANG-NHAP.cmd; các lần sau dùng lại phiên đã mã hóa.'),{code:'ADMIN_LOGIN_REQUIRED'});
  const prompt=createInterface({input:process.stdin,output:process.stdout});let email;
  try{email=(await prompt.question('Email quản trị web: ')).trim();}finally{prompt.close();}
  if(!email)throw Error('Vui lòng nhập email quản trị web.');
  const password=await hiddenPassword(),signed=await client.auth.signInWithPassword({email,password});
  if(signed.error)throw signed.error;
  return approvedAdmin(client,signed.data.user);
}
