import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const a='20000000-0000-4000-8000-000000000002',b='30000000-0000-4000-8000-000000000003';
function submit(user,content,hash){
  const id=randomUUID(),key=randomUUID();
  const sql=`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false);select (public.submit_brand_job_v2('${id}','${key}','${content}',1,10,'${hash.repeat(64)}')).id;`;
  return new Promise((resolve,reject)=>{
    const p=spawn('docker',['exec','muse-v2-db-test','psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres','-c',sql],{windowsHide:true});let out='',err='';
    p.stdout.on('data',s=>out+=s);p.stderr.on('data',s=>err+=s);p.on('error',reject);p.on('close',code=>code===0?resolve(out.trim().split(/\s+/).at(-1)):reject(Error(err)));
  });
}
const [first,second]=await Promise.all([submit(a,'Hai tai khoan dong thoi noi dung A','a'),submit(b,'Hai tai khoan dong thoi noi dung B','b')]);
assert.notEqual(first,second);
const [same1,same2]=await Promise.all([submit(a,'Nhan gui nhieu lan cung noi dung','c'),submit(a,'Nhan gui nhieu lan cung noi dung','c')]);
assert.equal(same1,same2);
console.log('CONCURRENT_USERS_OK; CONCURRENT_DUPLICATE_OK');
