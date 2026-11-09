import test from 'node:test';
import assert from 'node:assert/strict';
import {renderGrants} from './oauth-grants.mjs';
const userId='member-id';
function fixture(){
 let current=userId,grants=[{client:{id:'client-id',name:'Plugin <script>'},scopes:['email']}],revocations=[];
 const message={textContent:''},button={dataset:{client:'client-id'},disabled:false,addEventListener(_event,handler){this.click=handler}};
 const root={innerHTML:'',querySelectorAll:()=>grants.length?[button]:[],querySelector:()=>message};
 const client={auth:{getUser:async()=>({data:{user:{id:current}}}),oauth:{listGrants:async()=>({data:grants}),revokeGrant:async options=>{revocations.push(options);grants=[];return {data:{}}}}}};
 return {root,client,button,message,revocations,setCurrent:id=>current=id};
}
test('renders grants safely and revokes only after explicit confirmation',async()=>{
 const f=fixture();await renderGrants({root:f.root,client:f.client,userId,confirm:()=>true});
 assert.ok(f.root.innerHTML.includes('Plugin &lt;script&gt;'));assert.equal(f.revocations.length,0);
 await f.button.click();assert.deepEqual(f.revocations,[{clientId:'client-id'}]);assert.match(f.root.innerHTML,/Chưa có ứng dụng/);
});
test('canceling or changing account does not revoke a grant',async()=>{
 const f=fixture();await renderGrants({root:f.root,client:f.client,userId,confirm:()=>false});await f.button.click();assert.equal(f.revocations.length,0);
 await renderGrants({root:f.root,client:f.client,userId,confirm:()=>true});f.setCurrent('different-user');await f.button.click();assert.equal(f.revocations.length,0);assert.match(f.message.textContent,/đăng nhập lại/);
});
