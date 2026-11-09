// Low-level account-linking primitives. The caller must obtain userId from a
// trusted platform identity header, not from a query string or MCP argument.
const encoder = new TextEncoder(), decoder = new TextDecoder();
const ttl = 10 * 60 * 1000;
function b64(bytes) { let binary=''; for(const byte of bytes)binary+=String.fromCharCode(byte); return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function unb64(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value)||value.length>16000)throw new Error('Invalid envelope');
  const data=atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'='));
  return Uint8Array.from(data, char=>char.charCodeAt(0));
}
function random(n){return crypto.getRandomValues(new Uint8Array(n));}
async function key(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length!==32)throw new Error('A 256-bit secret is required');
  return crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
function aad(purpose,userId) {
  if(typeof userId!=='string'||!userId||userId.length>256)throw new Error('Authenticated identity required');
  return encoder.encode(`mr-studio-link-v1|${purpose}|${userId}`);
}
async function encrypt(secret,userId,purpose,payload){
  const iv=random(12),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(purpose,userId)},await key(secret),encoder.encode(JSON.stringify(payload)));
  return `v1.${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}
async function decrypt(secret,userId,purpose,envelope){
  if(typeof envelope!=='string')throw new Error('Invalid envelope');
  const parts=envelope.split('.');if(parts.length!==3||parts[0]!=='v1')throw new Error('Invalid envelope');
  const iv=unb64(parts[1]);if(iv.length!==12)throw new Error('Invalid envelope');
  try{return JSON.parse(decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(purpose,userId)},await key(secret),unb64(parts[2]))))}
  catch{throw new Error('Invalid or expired link');}
}

export async function createLinkState({secret,userId,now=Date.now()}){
  const verifier=b64(random(32));
  const challenge=b64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier))));
  const state=await encrypt(secret,userId,'oauth-state',{verifier,createdAt:now});
  return {state,challenge};
}
export async function readLinkState({secret,userId,state,now=Date.now()}){
  const value=await decrypt(secret,userId,'oauth-state',state);
  if(typeof value.verifier!=='string'||!Number.isSafeInteger(value.createdAt)||now<value.createdAt||now-value.createdAt>ttl)throw new Error('Invalid or expired link');
  return value.verifier;
}
export async function sealMemberSession({secret,userId,session}){
  if(!session||typeof session.refresh_token!=='string'||!session.refresh_token||typeof session.access_token!=='string'||!session.access_token)throw new Error('Invalid member session');
  return encrypt(secret,userId,'member-session',session);
}
export async function openMemberSession({secret,userId,envelope}){
  return decrypt(secret,userId,'member-session',envelope);
}
