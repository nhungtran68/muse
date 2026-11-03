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
export async function adminLoginV2(client){
  const prompt=createInterface({input:process.stdin,output:process.stdout});let email;
  try{email=(await prompt.question('Email quản trị web: ')).trim();}finally{prompt.close();}
  if(!email)throw Error('Vui lòng nhập email quản trị web.');
  const password=await hiddenPassword(),signed=await client.auth.signInWithPassword({email,password});
  if(signed.error)throw signed.error;
  const profile=await client.from('profiles').select('role,approved').eq('id',signed.data.user.id).single();
  if(profile.error||profile.data?.role!=='admin'||!profile.data?.approved){await client.auth.signOut();throw Error('Tài khoản này chưa có quyền quản trị.');}
  client.auth.startAutoRefresh();return signed.data.user;
}
