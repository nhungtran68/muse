import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConsentDetails,renderConsent,validateRedirect} from './oauth-consent.mjs';

const user='20000000-0000-4000-8000-000000000002',authId='request-id';
function fixture(){
 const calls=[];
 const details={authorization_id:authId,user:{id:user,email:'member@example.test'},client:{name:'Plugin <script>'},redirect_uri:'https://connector.test/callback',scope:'openid email'};
 const client={auth:{getUser:async()=>({data:{user:{id:user}}}),oauth:{
  getAuthorizationDetails:async()=>({data:details}),
  approveAuthorization:async(...args)=>{calls.push(['approve',...args]);return {data:{redirect_url:'https://connector.test/callback?code=example'}}},
  denyAuthorization:async(...args)=>{calls.push(['deny',...args]);return {data:{redirect_url:'https://connector.test/callback?error=access_denied'}}}
 }},from:()=>({select(){return this},eq(){return this},async maybeSingle(){return {data:{approved:true}}}})};
 const nodes=Object.fromEntries(['#approve-consent','#deny-consent','#consent-error'].map(k=>[k,{disabled:false,textContent:'',addEventListener(_event,handler){this.click=handler}}]));
 const root={innerHTML:'',querySelector:selector=>nodes[selector]};return {client,details,calls,nodes,root};
}
test('validates authenticated identity, account approval, and request ownership',async()=>{
 const f=fixture();assert.equal((await loadConsentDetails(f.client,authId,user)).authorization_id,authId);
 await assert.rejects(loadConsentDetails(f.client,authId,'another-user'));
 f.details.user.id='another-user';await assert.rejects(loadConsentDetails(f.client,authId,user),/không khớp/);
});
test('consent only approves after explicit click and escapes app data',async()=>{
 const f=fixture();let target='';await renderConsent({root:f.root,client:f.client,userId:user,authorizationId:authId,redirect:value=>{target=value}});
 assert.equal(f.calls.length,0);assert.ok(f.root.innerHTML.includes('Plugin &lt;script&gt;'));assert.ok(!f.root.innerHTML.includes('Plugin <script>'));assert.match(f.root.innerHTML,/bao gồm các thao tác quản trị/);
 f.nodes['#approve-consent'].click();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'approve');assert.equal(target,'https://connector.test/callback?code=example');
});
test('deny does not grant access',async()=>{
 const f=fixture();let target='';await renderConsent({root:f.root,client:f.client,userId:user,authorizationId:authId,redirect:value=>{target=value}});
 f.nodes['#deny-consent'].click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(f.calls[0][0],'deny');assert.match(target,/access_denied/);
});
test('does not approve if the signed-in member changes before the click',async()=>{
 const f=fixture();await renderConsent({root:f.root,client:f.client,userId:user,authorizationId:authId,redirect:()=>{throw Error('unexpected redirect')}});
 f.client.auth.getUser=async()=>({data:{user:{id:'another-user'}}});
 f.nodes['#approve-consent'].click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(f.calls.length,0);assert.match(f.nodes['#consent-error'].textContent,/đã thay đổi/);
});
test('unapproved accounts cannot access consent details',async()=>{
 const f=fixture();f.client.from=()=>({select(){return this},eq(){return this},async maybeSingle(){return {data:{approved:false}}}});
 await assert.rejects(loadConsentDetails(f.client,authId,user),/quản trị viên duyệt/);
});
test('rejects unsafe or invalid redirect URLs',()=>{assert.throws(()=>validateRedirect('javascript:alert(1)'));assert.throws(()=>validateRedirect('https://user:pass@example.test/'));assert.equal(validateRedirect('https://example.test/callback'),'https://example.test/callback')});
