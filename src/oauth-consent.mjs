function safe(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

export function validateRedirect(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Địa chỉ chuyển tiếp không an toàn.');
  return url.href;
}

export async function loadConsentDetails(client,authorizationId,expectedUserId){
  if(typeof authorizationId!=='string'||!authorizationId||authorizationId.length>512)throw new Error('Liên kết cấp quyền không hợp lệ.');
  const user=await client.auth.getUser();
  if(user.error||!user.data?.user?.id||user.data.user.id!==expectedUserId)throw new Error('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
  const profile=await client.from('profiles').select('approved').eq('id',expectedUserId).maybeSingle();
  if(profile.error||profile.data?.approved!==true)throw new Error('Tài khoản cần được quản trị viên duyệt trước khi kết nối.');
  const result=await client.auth.oauth.getAuthorizationDetails(authorizationId);
  if(result.error||!result.data)throw new Error('Không thể tải yêu cầu cấp quyền. Liên kết có thể đã hết hạn.');
  if('authorization_id' in result.data){
    if(result.data.authorization_id!==authorizationId||result.data.user?.id!==expectedUserId)throw new Error('Yêu cầu cấp quyền không khớp tài khoản.');
  } else validateRedirect(result.data.redirect_url);
  return result.data;
}

export async function renderConsent({root,client,userId,authorizationId,redirect=target=>location.assign(target)}){
  function showError(text){root.innerHTML=`<main class="fatal"><h1>Không thể liên kết tài khoản</h1><p>${safe(text)}</p><a class="outline" href="/">Về trang chủ</a></main>`;}
  try{
    const details=await loadConsentDetails(client,authorizationId,userId);
    if(!('authorization_id' in details)){redirect(validateRedirect(details.redirect_url));return;}
    const scopes=String(details.scope||'').split(/\s+/).filter(Boolean);
    root.innerHTML=`<main class="auth-panel" style="min-height:100vh"><section class="auth-box"><p class="eyebrow">MR STUDIO</p><h2>Cho phép liên kết?</h2><p class="muted"><strong>${safe(details.client?.name||'Ứng dụng bên ngoài')}</strong> yêu cầu kết nối với tài khoản <strong>${safe(details.user?.email||'của bạn')}</strong>.</p><p>Ứng dụng được cấp quyền có thể truy cập và thao tác theo quyền tài khoản của bạn trên Mr Studio, bao gồm gửi yêu cầu và xem kết quả.</p><p>Địa chỉ nhận kết quả cấp quyền: <strong>${safe(details.redirect_uri)}</strong></p><p>Quyền được yêu cầu: <strong>${safe(scopes.join(', ')||'Không có phạm vi được nêu')}</strong></p><p id="consent-error" role="alert"></p><div class="script-actions"><button type="button" class="outline" id="deny-consent">Từ chối</button><button type="button" class="primary" id="approve-consent">Cho phép</button></div></section></main>`;
    const approve=root.querySelector('#approve-consent'),deny=root.querySelector('#deny-consent'),error=root.querySelector('#consent-error');let busy=false;
    async function decide(allowed){
      if(busy)return;busy=true;approve.disabled=true;deny.disabled=true;error.textContent='';
      try{
        const current=await client.auth.getUser();
        if(current.error||current.data?.user?.id!==userId)throw new Error('Tài khoản đã thay đổi. Hãy mở lại yêu cầu liên kết.');
        const response=allowed?await client.auth.oauth.approveAuthorization(authorizationId,{skipBrowserRedirect:true}):await client.auth.oauth.denyAuthorization(authorizationId,{skipBrowserRedirect:true});
        if(response.error||!response.data?.redirect_url)throw new Error('Không thể xử lý yêu cầu. Hãy thử lại.');
        redirect(validateRedirect(response.data.redirect_url));
      }catch(e){error.textContent=e.message||'Không thể xử lý yêu cầu.';busy=false;approve.disabled=false;deny.disabled=false;}
    }
    approve.addEventListener('click',()=>void decide(true));deny.addEventListener('click',()=>void decide(false));
  }catch(error){showError(error.message||'Vui lòng thử lại.');}
}
