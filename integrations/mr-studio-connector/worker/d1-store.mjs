// A dedicated D1 database is required. Schema must be migrated before use.
// A durable refresh marker prevents replay after a timeout, and random lease
// IDs fence off stale writers when a lease expires.
export function createD1Store({db,clock=Date.now,randomUUID=()=>crypto.randomUUID(),leaseMs=30000}){
  if(!db?.prepare||!Number.isSafeInteger(leaseMs)||leaseMs<10000||leaseMs>120000)throw new Error('Invalid storage configuration');
  async function withUserLock(userId,fn){
    if(typeof userId!=='string'||!userId||userId.length>256||typeof fn!=='function')throw new Error('Invalid identity');
    const lockId=randomUUID(),now=clock(),until=now+leaseMs;
    const acquired=await db.prepare(`INSERT INTO link_sessions(user_id,lock_id,lock_until) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET lock_id=excluded.lock_id,lock_until=excluded.lock_until
      WHERE link_sessions.lock_until IS NULL OR link_sessions.lock_until<=?`).bind(userId,lockId,until,now).run();
    if(acquired.meta?.changes!==1)throw new Error('Tài khoản đang được xử lý. Hãy thử lại sau.');
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
      async replace(envelope){if(typeof envelope!=='string'||!envelope)throw new Error('Invalid envelope');await update('UPDATE link_sessions SET envelope=?,refresh_pending=0 WHERE user_id=? AND lock_id=? AND lock_until>?',envelope)}
    };
    try{return await fn(lease)}finally{await db.prepare('UPDATE link_sessions SET lock_id=NULL,lock_until=NULL WHERE user_id=? AND lock_id=?').bind(userId,lockId).run()}
  }
  return {withUserLock,async save(userId,envelope){return withUserLock(userId,lease=>lease.replace(envelope))}};
}
