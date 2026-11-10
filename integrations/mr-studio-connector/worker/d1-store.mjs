// A dedicated D1 database is required. Schema must be migrated before use.
// A durable refresh marker prevents replay after a timeout, and random lease
// IDs fence off stale writers when a lease expires.
export function createD1Store({db,clock=Date.now,randomUUID=()=>crypto.randomUUID(),leaseMs=30000,lockAttempts=12,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  if(!db?.prepare||!Number.isSafeInteger(leaseMs)||leaseMs<10000||leaseMs>120000)throw new Error('Invalid storage configuration');
  if(!Number.isSafeInteger(lockAttempts)||lockAttempts<1||lockAttempts>12||typeof sleep!=='function')throw new Error('Invalid lock retry configuration');
  async function withUserLock(userId,fn){
    if(typeof userId!=='string'||!userId||userId.length>256||typeof fn!=='function')throw new Error('Invalid identity');
    const lockId=randomUUID();let locked=false;
    for(let attempt=0;attempt<lockAttempts;attempt++){
      const now=clock();
      const acquired=await db.prepare(`INSERT INTO link_sessions(user_id,lock_id,lock_until) VALUES(?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET lock_id=excluded.lock_id,lock_until=excluded.lock_until
        WHERE link_sessions.lock_until IS NULL OR link_sessions.lock_until<=?`).bind(userId,lockId,now+leaseMs,now).run();
      if(acquired.meta?.changes===1){locked=true;break}
      if(attempt+1<lockAttempts)await sleep(Math.min(100*2**attempt,1000));
    }
    if(!locked)throw Object.assign(new Error('Tài khoản đang xử lý yêu cầu khác. Hãy thử lại sau.'),{code:'LOCK_BUSY'});
    async function row(){
      const result=await db.prepare('SELECT envelope,refresh_pending FROM link_sessions WHERE user_id=? AND lock_id=? AND lock_until>?').bind(userId,lockId,clock()).first();
      if(!result)throw new Error('Quyền xử lý đã hết hạn.');return result;
    }
    async function update(sql,...args){
      const result=await db.prepare(sql).bind(...args,userId,lockId,clock()).run();
      if(result.meta?.changes!==1)throw new Error('Quyền xử lý đã hết hạn hoặc phiên không hợp lệ.');
    }
    const lease={
      async read(){return (await row()).envelope},
      async isRefreshPending(){return (await row()).refresh_pending===1},
      async assertValid(){await row()},
      async beginRefresh(){await update('UPDATE link_sessions SET refresh_pending=1 WHERE user_id=? AND lock_id=? AND lock_until>? AND refresh_pending=0')},
      async finishRefresh(envelope){if(typeof envelope!=='string'||!envelope)throw new Error('Invalid envelope');await update('UPDATE link_sessions SET envelope=?,refresh_pending=0 WHERE user_id=? AND lock_id=? AND lock_until>? AND refresh_pending=1',envelope)},
      async replace(envelope){if(typeof envelope!=='string'||!envelope)throw new Error('Invalid envelope');await update('UPDATE link_sessions SET envelope=?,refresh_pending=0 WHERE user_id=? AND lock_id=? AND lock_until>?',envelope)},
      async clear(){await update('UPDATE link_sessions SET envelope=NULL,refresh_pending=0 WHERE user_id=? AND lock_id=? AND lock_until>?')}
    };
    try{return await fn(lease)}finally{await db.prepare('UPDATE link_sessions SET lock_id=NULL,lock_until=NULL WHERE user_id=? AND lock_id=?').bind(userId,lockId).run()}
  }
  return {withUserLock,async save(userId,envelope){return withUserLock(userId,lease=>lease.replace(envelope))}};
}
