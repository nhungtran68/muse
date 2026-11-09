import {openMemberSession,sealMemberSession} from './link-crypto.mjs';

// store.withUserLock MUST provide a durable, cross-process lock with fencing.
// Its callback receives a lease exposing read(), isRefreshPending(),
// beginRefresh(), finishRefresh(envelope) and assertValid(). A refresh marker
// stays set after a crash or timeout so a rotating token is never replayed.
// A production implementation must not substitute an in-memory lock.
export function createSessionManager({secret,authBase,clientId,store,verifyMember,fetcher=fetch,clock=Date.now}){
  const auth=new URL(authBase);
  if(auth.protocol!=='https:'||auth.search||auth.hash||!clientId||typeof store?.withUserLock!=='function'||typeof verifyMember!=='function')throw new Error('Invalid session configuration');
  return async function resolveSession(userId){
    if(typeof userId!=='string'||!userId)throw new Error('Cần đăng nhập.');
    return store.withUserLock(userId,async lease=>{
      const envelope=await lease.read();if(!envelope)throw new Error('Cần liên kết tài khoản.');
      if(await lease.isRefreshPending())throw new Error('Cần liên kết lại tài khoản sau khi phiên bị gián đoạn.');
      let session;try{session=await openMemberSession({secret,userId,envelope})}catch{throw new Error('Cần liên kết lại tài khoản.')}
      if(!session||typeof session.member_id!=='string'||typeof session.access_token!=='string'||typeof session.refresh_token!=='string'||!Number.isFinite(session.expires_at))throw new Error('Cần liên kết lại tài khoản.');
      if(session.expires_at-clock()<=30000){
        await lease.beginRefresh();
        let response;
        try{response=await fetcher(`${auth.href.replace(/\/$/,'')}/oauth/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:session.refresh_token}),signal:AbortSignal.timeout(8000)})}catch{throw new Error('Không thể xác minh phiên. Hãy thử lại sau.')}
        if(!response.ok)throw new Error('Cần liên kết lại tài khoản.');
        const fresh=await response.json();
        if(typeof fresh.access_token!=='string'||!fresh.access_token||fresh.token_type?.toLowerCase()!=='bearer'||typeof fresh.expires_in!=='number'||fresh.expires_in<1||fresh.expires_in>86400||(fresh.refresh_token!==undefined&&(typeof fresh.refresh_token!=='string'||!fresh.refresh_token)))throw new Error('Cần liên kết lại tài khoản.');
        session={...session,access_token:fresh.access_token,refresh_token:fresh.refresh_token||session.refresh_token,expires_at:clock()+fresh.expires_in*1000};
        // Fenced writes must fail if the lock was lost. Never call a tool when
        // the rotated refresh token could not be stored.
        await lease.finishRefresh(await sealMemberSession({secret,userId,session}));
      }
      const member=await verifyMember(session.access_token);
      if(member?.id!==session.member_id||member.approved!==true)throw new Error('Cần kiểm tra lại tài khoản đã liên kết.');
      await lease.assertValid();
      return {accessToken:session.access_token,memberId:member.id};
    });
  };
}
