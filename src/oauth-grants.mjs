function safe(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

async function ensureUser(client,userId){
  const result=await client.auth.getUser();
  if(result.error||result.data?.user?.id!==userId)throw new Error('Phiên đăng nhập đã thay đổi. Hãy đăng nhập lại.');
}

export async function renderGrants({root,client,userId,confirm=message=>window.confirm(message)}){
  async function refresh(){
    try{
      await ensureUser(client,userId);
      const result=await client.auth.oauth.listGrants();
      if(result.error||!Array.isArray(result.data))throw new Error('Không thể tải danh sách ứng dụng đã liên kết.');
      const grants=result.data.filter(g=>typeof g.client?.id==='string'&&g.client.id);
      root.innerHTML=`<main class="auth-panel" style="min-height:100vh"><section class="auth-box"><p class="eyebrow">MR STUDIO</p><h2>Ứng dụng đã liên kết</h2><p class="muted">Bạn có thể thu hồi quyền truy cập của ứng dụng bất cứ lúc nào.</p><div id="grants-list">${grants.length?grants.map(g=>`<div class="mini-row"><div><strong>${safe(g.client.name||'Ứng dụng')}</strong><small>Quyền: ${safe((Array.isArray(g.scopes)?g.scopes:[]).join(', ')||'Không được nêu')}</small></div><button class="outline revoke-grant" type="button" data-client="${safe(g.client.id)}">Thu hồi</button></div>`).join(''):'<p>Chưa có ứng dụng nào được liên kết.</p>'}</div><p id="grants-message" role="status"></p><a class="outline" href="/">Về trang chủ</a></section></main>`;
      for(const button of root.querySelectorAll('.revoke-grant'))button.addEventListener('click',async()=>{
        const clientId=button.dataset.client;if(!grants.some(g=>g.client.id===clientId)||button.disabled)return;
        if(!confirm('Thu hồi quyền của ứng dụng này? Ứng dụng sẽ cần liên kết lại để sử dụng.'))return;
        button.disabled=true;const message=root.querySelector('#grants-message');message.textContent='Đang thu hồi…';
        try{await ensureUser(client,userId);const result=await client.auth.oauth.revokeGrant({clientId});if(result.error)throw new Error('Không thể thu hồi quyền.');await refresh()}
        catch(error){message.textContent=error.message||'Không thể thu hồi quyền.';button.disabled=false;}
      });
    }catch(error){root.innerHTML=`<main class="fatal"><h1>Không thể tải kết nối</h1><p>${safe(error.message||'Hãy thử lại.')}</p><a class="outline" href="/">Về trang chủ</a></main>`;}
  }
  await refresh();
}
