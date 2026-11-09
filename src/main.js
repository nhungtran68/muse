import {createClient} from '@supabase/supabase-js';
import {adminEmail, supabaseKey, supabaseUrl} from './config.js';
import {validateEditedDialogue} from '../shared/brand-video-prompt.mjs';
import {CREATION_MODES,getCreationMode,isSingleMediaScene} from '../shared/creation-modes.mjs';
import {normalizeReferenceImage} from './image-normalization.mjs';
import {hasUncertainSubmission, visibleSceneStatus} from './job-recovery.mjs';
import {uploadMedia,downloadMedia,signedMediaUrl} from '../shared/media-storage.mjs';
import './styles.css';
import './brand-script.css';
import './pwa.js';
import {displayMessage} from './display-text.mjs';
import {renderConsent} from './oauth-consent.mjs';

const root = document.querySelector('#app');
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const shortDate = value => new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
const labels = {uploading:'Đang tải ảnh',queued:'Đang xếp hàng',planning:'AI chia cảnh',generating:'Đang tạo cảnh',joining:'Đang ghép',done:'Hoàn tất',needs_review:'Cần kiểm tra',reviewed:'Đã kiểm tra'};
let session = null, profile = null, settings = null, modes = [], poller = null, previewUrl = null, jobsSignature = '', appEpoch = 0, jobsRefreshVersion = 0, sceneRetryAvailable = null, jobsVisibleCount = 3, jobsTotalCount = 0, retentionClock = null;
let preparedReference=null,referenceNormalizationSequence=0;
let controlStatusLoading=false,controlStarting=false;
const retryingJobs=new Set(),retryingScenes=new Set();
const retentionExpiredRefreshes=new Set();

function message(text, type='info') {
  const box = document.querySelector('#notice');
  if (box) {box.textContent=displayMessage(text); box.className='notice '+type; box.hidden=false;}
}
function clearMessage() { const box=document.querySelector('#notice'); if(box) box.hidden=true; }
function on(selector,event,handler) { document.querySelector(selector)?.addEventListener(event,handler); }
function showLoading() { root.innerHTML='<main class="loading"><span class="spinner"></span><p>Đang mở không gian sáng tạo…</p></main>'; }

function authView(mode='login') {
  clearInterval(poller);
  clearInterval(retentionClock);
  root.innerHTML=`<div class="auth-layout"><div class="auth-art"><div class="brandmark">M<span>•</span></div><p class="eyebrow">MR STUDIO</p><h1>Từ ý tưởng<br>đến thước phim.</h1><p>Một không gian để tạo ảnh, video và theo dõi các ý tưởng thành hình.</p><div class="art-lines"><i></i><i></i><i></i></div></div><main class="auth-panel"><div class="auth-box"><p class="eyebrow">TÀI KHOẢN</p><h2>${mode==='signup'?'Tạo tài khoản':'Chào mừng trở lại'}</h2><p class="muted">${mode==='signup'?'Đăng ký bằng email. Quản trị viên sẽ duyệt trước khi bạn tạo video.':'Đăng nhập để tiếp tục sáng tạo.'}</p><form id="auth-form"><label>Email<input id="auth-email" type="email" autocomplete="email" required></label><label>Mật khẩu<input id="auth-password" type="password" autocomplete="${mode==='signup'?'new-password':'current-password'}" minlength="12" required></label><button class="primary full" type="submit">${mode==='signup'?'Đăng ký':'Đăng nhập'} <span aria-hidden="true">↗</span></button></form><div id="notice" class="notice" hidden role="status"></div><button id="switch-auth" class="text-button">${mode==='signup'?'Đã có tài khoản? Đăng nhập':'Chưa có tài khoản? Đăng ký'}</button></div></main></div>`;
  on('#switch-auth','click',()=>authView(mode==='signup'?'login':'signup'));
  on('#auth-form','submit',async event=>{
    event.preventDefault(); clearMessage();
    const email=document.querySelector('#auth-email').value.trim(),password=document.querySelector('#auth-password').value;
    const button=event.submitter||event.currentTarget.querySelector('[type=submit]');button.disabled=true;button.textContent='Đang xử lý…';
    const result=mode==='signup'?await supabase.auth.signUp({email,password}):await supabase.auth.signInWithPassword({email,password});
    if(result.error){message(result.error.message,'error');button.disabled=false;button.textContent=mode==='signup'?'Đăng ký':'Đăng nhập';return;}
    if(mode==='signup'&&!result.data.session){message('Đã gửi email xác nhận. Hãy xác nhận email rồi đăng nhập.','success');button.disabled=false;button.textContent='Đăng ký';return;}
    await loadApp();
  });
}

async function loadProfile(userId) {
  const {data,error}=await supabase.from('profiles').select('*').eq('id',userId).maybeSingle();
  if(error) throw error;
  const settingResult=await supabase.from('app_settings').select('*').eq('id',true).single();
  if(settingResult.error) throw settingResult.error;
  const modeResult=await supabase.from('video_modes').select('seconds').eq('enabled',true).order('seconds');
  if(modeResult.error)throw modeResult.error;
  if(session?.user.id!==userId)return false;
  profile=data;settings=settingResult.data;modes=modeResult.data;return true;
}

function shell() {
  const isAdmin=profile?.role==='admin'&&profile.approved;
  root.innerHTML=`<div class="app-shell"><aside class="sidebar"><a class="wordmark" href="#home" aria-label="Mr Studio, trang chủ"><span class="brandmark small">M<span>•</span></span><span>Mr Studio</span></a><div class="side-caption">KHÔNG GIAN LÀM VIỆC</div><nav aria-label="Điều hướng"><a class="nav-item active" href="#home"><span aria-hidden="true">✦</span> Tạo nội dung</a><a class="nav-item" href="#jobs"><span aria-hidden="true">◷</span> Kết quả của tôi</a>${isAdmin?'<a class="nav-item" href="#admin"><span aria-hidden="true">⚙</span> Quản trị</a>':''}</nav><div class="side-bottom"><span class="avatar">${safe((profile?.email||'U')[0].toUpperCase())}</span><div><strong>${safe(profile?.email||session.user.email)}</strong><small>${isAdmin?'Quản trị viên':profile?.approved?'Thành viên':'Chờ duyệt'}</small></div></div></aside><div class="main-column"><header class="topbar"><button class="mobile-brand" id="menu-toggle" aria-label="Mở điều hướng">☰</button><a class="top-wordmark" href="#home"><span class="brandmark tiny">M<span>•</span></span><span>Mr Studio</span></a><button class="outline small-button" id="signout">Đăng xuất</button></header><main class="workspace"><div id="notice" class="notice" hidden role="status"></div><section id="home" class="creation-home" aria-labelledby="home-title"><div class="home-heading"><p class="eyebrow">MR STUDIO</p><h1 id="home-title">Bạn muốn sáng tạo gì hôm nay?</h1><p>Chọn chế độ, mô tả ý tưởng và gửi một lần.</p></div><section id="brand" class="module"></section></section><section id="jobs" class="jobs-section"></section>${isAdmin?'<section id="admin" class="admin-section"></section>':''}</main></div></div>`;
  on('#signout','click',async()=>{await supabase.auth.signOut();session=null;profile=null;authView();});
  on('#menu-toggle','click',()=>document.querySelector('.sidebar').classList.toggle('open'));
  document.querySelectorAll('.sidebar .nav-item').forEach(link=>link.addEventListener('click',()=>document.querySelector('.sidebar')?.classList.remove('open')));
  renderModule(); renderJobs(); if(isAdmin) renderAdmin();
}

function renderModule() {
  const section=document.querySelector('#brand');
  if(!profile){section.innerHTML='<div class="empty">Không tìm thấy hồ sơ. Hãy đăng xuất và thử lại.</div>';return;}
  if(!profile.approved){
    section.innerHTML=`<div class="pending"><span class="pending-icon">◌</span><div><p class="eyebrow">CHỜ KÍCH HOẠT</p><h2>Tài khoản đang chờ duyệt</h2><p>Quản trị viên cần duyệt tài khoản trước khi bạn gửi yêu cầu tạo video.</p>${session.user.email.toLowerCase()===adminEmail?'<form id="claim-form" class="claim-form"><label>Mã thiết lập quản trị<input id="claim-code" autocomplete="off" required></label><button class="primary" type="submit">Kích hoạt quản trị</button></form>':''}</div></div>`;
    on('#claim-form','submit',async event=>{event.preventDefault();const code=document.querySelector('#claim-code').value.trim();const {error}=await supabase.rpc('claim_admin',{setup_code:code});if(error)return message(error.message,'error');await loadApp();});
    return;
  }
  preparedReference=null;referenceNormalizationSequence++;
  section.innerHTML=`<div class="composer-card"><form id="create-form" class="single-composer">
    <div class="composer-mode"><label for="creation-mode">Chế độ tạo</label><div class="mode-select-wrap"><select id="creation-mode" aria-describedby="mode-description">${CREATION_MODES.map(mode=>`<option value="${mode.id}">${mode.label}</option>`).join('')}</select><span aria-hidden="true">⌄</span></div></div>
    <label class="sr-only" for="content">Mô tả nội dung muốn tạo</label><textarea id="content" rows="5" minlength="10" maxlength="4000" required></textarea>
    <div class="composer-attachments"><input id="reference" type="file" accept="image/png,image/jpeg,image/webp"><label class="attach-control" for="reference"><span class="attach-icon" aria-hidden="true">＋</span><span id="file-name">Thêm ảnh tham chiếu</span></label><button id="remove-reference" class="text-button remove-reference" type="button" hidden>Xóa ảnh</button><small id="reference-hint">JPG, PNG hoặc WebP · tối đa 10 MB</small><img id="image-preview" alt="Ảnh tham chiếu đã chọn" hidden><span class="image-processing-status" id="image-processing-status" role="status" aria-live="polite"></span></div>
    <div class="composer-bottom"><span class="mode-note" id="mode-description" aria-live="polite"></span><button class="primary create-button" type="submit">Gửi <span aria-hidden="true">↑</span></button></div>
    <p class="consent"><span aria-hidden="true">ⓘ</span> Yêu cầu và ảnh đính kèm được xử lý qua hệ thống của đơn vị vận hành. Mỗi lần gửi nhận một kết quả.</p>${settings.enabled?'':'<p class="inline-warning">Quản trị viên đang tạm dừng nhận yêu cầu.</p>'}</form></div><p class="composer-footnote" id="composer-footnote"></p>`;
  const form=section.querySelector('#create-form'),modeInput=section.querySelector('#creation-mode');
  const referenceInput=section.querySelector('#reference');
  const imageStatus=section.querySelector('#image-processing-status');
  const createButton=section.querySelector('.create-button');
  const syncCreateButton=()=>{const mode=getCreationMode(modeInput.value);createButton.disabled=form.dataset.busy==='true'||!settings.enabled||(mode.id==='video_10s'&&!modes.some(item=>item.seconds===10))||(mode.referenceRequired&&!preparedReference)||(Boolean(referenceInput.files[0])&&!preparedReference);};
  const prepareImage=async()=>{
    const mode=getCreationMode(modeInput.value);
    const sequence=++referenceNormalizationSequence,file=referenceInput.files[0],image=section.querySelector('#image-preview');
    preparedReference=null;syncCreateButton();
    section.querySelector('#remove-reference').hidden=!file;
    if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}
    if(!file){image.hidden=true;image.removeAttribute('src');section.querySelector('#file-name').textContent='Thêm ảnh tham chiếu';imageStatus.textContent='';imageStatus.dataset.state='';return;}
    image.hidden=true;image.removeAttribute('src');section.querySelector('#file-name').textContent=file.name;imageStatus.textContent=mode.id==='video_10s'?'Đang chuẩn hóa ảnh theo khung dọc 9:16…':'Đang kiểm tra ảnh tham chiếu…';imageStatus.dataset.state='working';
    try{
      const result=await normalizeReferenceImage(file,{preserveAspect:mode.id!=='video_10s'});
      if(sequence!==referenceNormalizationSequence)return;
      preparedReference=result.file;previewUrl=URL.createObjectURL(result.file);image.src=previewUrl;image.hidden=false;
      section.querySelector('#file-name').textContent=result.preserved?file.name:`${file.name} · đã chuẩn hóa 9:16`;
      imageStatus.textContent=result.preserved?`Ảnh ${result.width} × ${result.height} · giữ nguyên tỷ lệ gốc.`:result.padded?`Đã xử lý thành ảnh 720 × 1280. Giữ nguyên tỷ lệ, thêm phần đệm để không cắt mất nội dung.`:`Đã xử lý thành ảnh 720 × 1280 (9:16), không kéo méo ảnh.`;
      imageStatus.dataset.state='ready';
    }catch(error){
      if(sequence!==referenceNormalizationSequence)return;
      imageStatus.textContent=displayMessage(error.message)||'Không xử lý được ảnh. Hãy lưu lại ảnh dưới dạng JPG, PNG hoặc WebP rồi thử lại.';
      imageStatus.dataset.state='error';
    }finally{if(sequence===referenceNormalizationSequence)syncCreateButton();}
  };
  const syncMode=()=>{
    const mode=getCreationMode(modeInput.value);referenceInput.required=mode.referenceRequired;
    section.querySelector('#content').placeholder=mode.placeholder;
    section.querySelector('#mode-description').textContent=mode.id==='video_10s'&&!modes.some(item=>item.seconds===10)?'Chế độ 10 giây đang tạm tắt':mode.hint;
    section.querySelector('#reference-hint').textContent=`${mode.referenceRequired?'Cần một ảnh':'Ảnh không bắt buộc'} · JPG, PNG, WebP · tối đa 10 MB`;
    section.querySelector('#composer-footnote').textContent=mode.id==='image'?'Thêm ảnh tham chiếu nếu cần giữ chủ thể hoặc phong cách. Kết quả là một ảnh để xem và tải xuống.':mode.id==='video_free'?'Nhập độ dài và khung hình mong muốn trong mô tả. Hệ thống tự xử lý và ghép thành một video hoàn chỉnh.':'Thêm một ảnh tham chiếu. Kết quả là một video dọc 10 giây theo mô tả của bạn.';
    syncCreateButton();
  };
  referenceInput.addEventListener('change',prepareImage);
  modeInput.addEventListener('change',()=>{syncMode();prepareImage();});
  on('#remove-reference','click',()=>{referenceInput.value='';prepareImage();});
  form.addEventListener('composer-sync',syncMode);syncMode();
  on('#create-form','submit',submitBrand);
}

async function fileHash(file){
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
async function submitBrand(event) {
  event.preventDefault();clearMessage();
  const form=event.currentTarget;if(form.dataset.busy==='true')return;
  const userId=session?.user.id;
  if(!userId)return;
  const submitClient=createClient(supabaseUrl,supabaseKey,{global:{headers:{Authorization:'Bearer '+session.access_token}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const selectedFile=document.querySelector('#reference').files[0],file=preparedReference;
  if(selectedFile&&!file)return message(document.querySelector('#image-processing-status')?.textContent||'Ảnh đang được xử lý. Hãy chờ hoàn tất rồi thử lại.','error');
  const mode=getCreationMode(form.querySelector('#creation-mode').value);
  if(mode.referenceRequired&&!file)return message('Chọn ảnh JPG, PNG hoặc WebP để tiếp tục.','error');
  const content=document.querySelector('#content').value.trim();
  if(content.length<10)return message('Hãy mô tả yêu cầu, tối thiểu 10 ký tự.','error');
  if(mode.id==='video_10s'&&!modes.some(item=>item.seconds===10))return message('Chế độ video 10 giây đang tạm tắt. Hãy chọn chế độ khác hoặc báo quản trị viên.','error');
  form.dataset.busy='true';form.querySelectorAll('input,textarea,select,button').forEach(input=>input.disabled=true);
  const button=event.submitter||form.querySelector('[type=submit]');button.textContent='Đang gửi…';message('Đang gửi yêu cầu xử lý…');
  try{
    const referenceHash=file?await fileHash(file):null;
    if(session?.user.id!==userId)return;
    const fingerprint=await fileHash(new Blob([JSON.stringify(['single-media-v1',userId,content,mode.id,referenceHash])]));
    const storageKey='muse-single-media-submit:'+userId;
    let pending;try{pending=JSON.parse(localStorage.getItem(storageKey));}catch{}
    if(!pending||pending.fingerprint!==fingerprint)pending={id:crypto.randomUUID(),key:crypto.randomUUID(),fingerprint};
    localStorage.setItem(storageKey,JSON.stringify(pending));
    const created=await submitClient.rpc('submit_single_media_job',{p_id:pending.id,p_request_key:pending.key,p_content:content,p_mode:mode.id,p_reference_sha256:referenceHash});
    if(created.error)throw created.error;
    const job=created.data;
    if(job.status==='uploading'){
      if(!file)throw Error('Yêu cầu này cần tải lại ảnh tham chiếu.');
      try{await uploadMedia(submitClient,{provider:job.reference_storage_provider,bucket:'brand-references',path:job.reference_path,jobId:job.id,token:session.access_token,contentType:file.type,data:file});}
      catch(error){if(job.reference_storage_provider==='r2')throw error;const existing=await submitClient.storage.from('brand-references').download(job.reference_path);if(existing.error||await fileHash(existing.data)!==referenceHash)throw error;}
      const queued=await submitClient.rpc('queue_brand_job',{p_id:job.id});if(queued.error)throw queued.error;
    }
    localStorage.removeItem(storageKey);
    if(session?.user.id!==userId)return;
    message(`Đã gửi một yêu cầu hoàn chỉnh (${mode.label}). Theo dõi trong “Kết quả của tôi”.`,'success');
    document.querySelector('#create-form').reset();document.querySelector('#content').dispatchEvent(new Event('input'));
    form.querySelector('#creation-mode').value=mode.id;
    preparedReference=null;referenceNormalizationSequence++;if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}
    document.querySelector('#image-preview').hidden=true;document.querySelector('#image-preview').removeAttribute('src');document.querySelector('#file-name').textContent='Thêm ảnh tham chiếu';
    const imageStatus=document.querySelector('#image-processing-status');if(imageStatus){imageStatus.textContent='';imageStatus.dataset.state='';}
    form.querySelector('#remove-reference').hidden=true;
    await refreshJobs();document.querySelector('#jobs').scrollIntoView({behavior:'smooth'});
  }catch(error){if(session?.user.id===userId)message(error.message||'Không gửi được yêu cầu. Hãy thử lại.','error');}
  finally{if(form.isConnected){form.dataset.busy='false';form.querySelectorAll('input,textarea,select,button').forEach(input=>input.disabled=false);button.textContent='Gửi';form.dispatchEvent(new Event('composer-sync'));}}
}

function renderJobs() {
  jobsSignature='';
  jobsVisibleCount=3;jobsTotalCount=0;
  clearInterval(retentionClock);
  document.querySelector('#jobs').innerHTML='<div class="section-head"><div><p class="eyebrow">THƯ VIỆN CỦA TÔI</p><h2>Kết quả của tôi</h2></div><span class="section-note">Tiến độ và kết quả các yêu cầu</span></div><p class="retention-intro">Ảnh và video hoàn tất được lưu trong 60 phút. Hãy tải xuống thiết bị trước khi hết hạn.</p><div id="jobs-list" class="jobs-list"><div class="empty">Đang tải kết quả…</div></div><div id="jobs-pagination" class="jobs-pagination" aria-live="polite"></div>';
  retentionClock=setInterval(updateRetentionCountdowns,1000);
  refreshJobs();
}

function formatRemaining(milliseconds) {
  const total=Math.max(0,Math.floor(milliseconds/1000));
  return `${Math.floor(total/60)} phút ${String(total%60).padStart(2,'0')} giây`;
}

function updateRetentionCountdowns() {
  document.querySelectorAll('.download-file').forEach(link=>{
    if(Number(link.dataset.refreshAt||Infinity)<=Date.now())link.refreshDownloadLink?.();
  });
  document.querySelectorAll('.job-thumbnail[data-expiry]').forEach(image=>{
    if(!image.dataset.expiry||Date.parse(image.dataset.expiry)>Date.now())return;
    image.hidden=true;image.removeAttribute('src');
    const card=image.closest('.job-card'),key=`${card?.dataset.jobId}:${image.dataset.expiry}`;
    if(card?.dataset.jobId&&!retentionExpiredRefreshes.has(key)){retentionExpiredRefreshes.add(key);refreshJobs();}
  });
  document.querySelectorAll('.retention-timer[data-expiry],.scene-expiry-timer[data-expiry]').forEach(timer=>{
    const remaining=Date.parse(timer.dataset.expiry)-Date.now();
    timer.textContent=remaining>0?formatRemaining(remaining):'đang chờ máy chủ xác nhận xóa';
    const notice=timer.classList.contains('retention-timer')?timer.closest('.retention-state'):null;
    notice?.classList.toggle('retention-active',remaining>10*60*1000);
    notice?.classList.toggle('retention-warning',remaining<=10*60*1000&&remaining>5*60*1000);
    notice?.classList.toggle('retention-urgent',remaining<=5*60*1000);
    if(remaining<=0){
      const card=timer.closest('.job-card');
      card?.querySelectorAll('.view-video,.download-final').forEach(element=>{
        if(Date.parse(element.dataset.expiry||'')<=Date.now()){
          element.disabled=true;element.hidden=true;
          const slotId=element.dataset.slot;
          const slot=slotId?document.getElementById(slotId):card.querySelector(`#video-${CSS.escape(card.dataset.jobId)}`);
          slot?.replaceChildren();
        }
      });
      const refreshKey=`${card?.dataset.jobId}:${timer.dataset.expiry}`;
      if(card?.dataset.jobId&&!retentionExpiredRefreshes.has(refreshKey)){retentionExpiredRefreshes.add(refreshKey);refreshJobs();}
    }
  });
}

function retentionMarkup(job) {
  if(job.status!=='done')return '';
  if(job.retention_status==='expired')return '<div class="expired-label retention-state" role="status">Đã hết hạn – File đã được xóa</div>';
  let warning='';
  if(job.retention_status==='deleting')warning='<div class="expiry-warning retention-state" role="status">Một số file đã hết hạn; hệ thống đang xác nhận xóa. File còn hạn vẫn khả dụng.</div>';
  else if(job.retention_status==='delete_failed'&&job.retention_next_attempt_at)warning=`<div class="expiry-warning retention-state" role="status">Hệ thống sẽ thử xóa lại file đã hết hạn (lần ${Number(job.retention_attempts||0)}/5); file chưa xác nhận xóa vẫn bị ẩn.</div>`;
  else if(job.retention_status==='delete_failed')warning='<div class="expiry-warning retention-state" role="status">Không xóa được một số file sau các lần thử lại. File đã quá hạn vẫn bị khóa; quản trị viên cần kiểm tra.</div>';
  if(job.final_path&&job.output_expires_at){
    const remaining=Date.parse(job.output_expires_at)-Date.now();
    return `${warning}<div class="expiry-warning retention-state ${remaining<=5*60*1000?'retention-urgent':remaining<=10*60*1000?'retention-warning':'retention-active'}" role="status"><span>Ảnh/video của bạn đã được tạo thành công. Mỗi file tự động xóa sau 60 phút kể từ khi file đó tạo xong. Vui lòng tải về thiết bị trước khi hết hạn.</span><strong class="retention-badge">Kết quả còn: <span class="retention-timer" data-expiry="${safe(job.output_expires_at)}">${remaining>0?formatRemaining(remaining):'đang chờ máy chủ xác nhận xóa'}</span></strong></div>`;
  }
  if(warning)return warning;
  return '<div class="retention-badge retention-state" role="status">Kết quả được tạo trước khi áp dụng thời hạn lưu tự động.</div>';
}

function mediaStillAvailable(retentionStatus,expiresAt) {
  return retentionStatus!=='expired'&&(!expiresAt||Date.parse(expiresAt)>Date.now());
}

function canDownloadFinal(job) {
  return job.status==='done'&&Boolean(job.final_path)&&mediaStillAvailable(job.retention_status,job.output_expires_at);
}

function prepareDownloadLink(link,{path,id,scene,userId,retentionStatus,expiresAt,provider}) {
  const filename=`muse-${id}${scene?`-doan-${scene}`:''}.${path.match(/\.(png|jpe?g|webp|mp4)$/i)?.[1]||'mp4'}`;
  const label=link.dataset.label||'Tải xuống';
  let busy=false,validUntil=0,lastError='';
  const usable=()=>link.isConnected&&session?.user.id===userId&&mediaStillAvailable(retentionStatus,expiresAt);
  const prepare=async()=>{
    if(busy||!usable())return;
    busy=true;link.dataset.refreshAt='';
    if(!link.hasAttribute('href')||Date.now()>=validUntil){link.removeAttribute('href');link.setAttribute('aria-disabled','true');link.textContent='Đang chuẩn bị…';}
    try{
      const ttl=Math.min(540,expiresAt?Math.max(1,Math.floor((Date.parse(expiresAt)-Date.now())/1000)):540);
      const url=await signedMediaUrl(supabase,{provider,bucket:'brand-videos',path,jobId:id,token:session.access_token,expiresIn:ttl,download:filename});
      if(!usable())return;
      validUntil=Date.now()+ttl*1000;lastError='';link.href=url;link.download=filename;link.removeAttribute('aria-disabled');link.textContent=label;
      link.dataset.refreshAt=String(Date.now()+Math.max(1,ttl-60)*1000);
    }catch(error){
      if(!usable())return;
      lastError=error.message||'Không kết nối được kho file.';
      if(Date.now()>=validUntil){link.removeAttribute('href');link.removeAttribute('aria-disabled');link.textContent='Thử tải lại';}
      else link.dataset.refreshAt=String(Date.now()+30000);
    }finally{busy=false;}
  };
  link.refreshDownloadLink=prepare;
  link.addEventListener('click',event=>{
    if(!usable()){event.preventDefault();message('File đã hết hạn hoặc phiên đăng nhập đã thay đổi.','error');return;}
    if(!link.hasAttribute('href')||Date.now()>=validUntil){
      event.preventDefault();
      if(lastError)message('Chưa chuẩn bị được file: '+lastError+'. Đang thử lại.','error');
      else if(!busy)message('Liên kết đã hết hạn, đang chuẩn bị lại. Hãy bấm tải xuống khi sẵn sàng.','info');
      prepare();
    }
  });
  link.addEventListener('keydown',event=>{if(!link.hasAttribute('href')&&(event.key==='Enter'||event.key===' ')){event.preventDefault();link.click();}});
  prepare();
}

function updateJobsPagination() {
  const controls=document.querySelector('#jobs-pagination');if(!controls)return;
  controls.classList.add('history-controls');
  if(!jobsTotalCount||jobsVisibleCount>=jobsTotalCount){controls.innerHTML=jobsVisibleCount>3?'<button class="text-button jobs-collapse" type="button">Thu gọn</button>':'';}
  else controls.innerHTML=`<button class="outline jobs-more" type="button">Xem thêm lịch sử <span>(${Math.min(3,jobsTotalCount-jobsVisibleCount)} kết quả)</span></button>${jobsVisibleCount>3?'<button class="text-button jobs-collapse" type="button">Thu gọn</button>':''}`;
  controls.querySelector('.jobs-more')?.addEventListener('click',async event=>{
    const button=event.currentTarget;
    if([...document.querySelectorAll('.script-editor')].some(editor=>editor.dataset.dirty==='true'||editor.dataset.busy==='true')){message('Hãy lưu lời thoại đang chỉnh sửa trước khi mở rộng lịch sử.','info');return;}
    button.disabled=true;jobsVisibleCount+=3;jobsSignature='';await refreshJobs({force:true});
  });
  controls.querySelector('.jobs-collapse')?.addEventListener('click',async()=>{
    if([...document.querySelectorAll('.script-editor')].some(editor=>editor.dataset.dirty==='true'||editor.dataset.busy==='true')){message('Hãy lưu lời thoại đang chỉnh sửa trước khi thu gọn lịch sử.','info');return;}
    jobsVisibleCount=3;jobsSignature='';await refreshJobs({force:true});document.querySelector('#jobs')?.scrollIntoView({behavior:'smooth',block:'start'});
  });
}

function renderScriptEditor(job,card,userId){
  const plan=Array.isArray(job.plan)?job.plan:[];
  const slot=card.querySelector('.job-action');
  if(plan.length!==job.scene_count||plan.some((scene,i)=>scene.index!==i+1||scene.seconds!==10)){
    slot.insertAdjacentHTML('beforeend','<p class="job-error">Kịch bản chưa khớp số đoạn. Hãy liên hệ quản trị viên.</p>');return;
  }
  const editor=document.createElement('div');editor.className='script-editor';editor.dataset.revision=String(job.script_revision);editor.dataset.dirty='false';
  editor.innerHTML=`<h4>Kịch bản để bạn chỉnh sửa</h4><p class="muted">Kịch bản đã sẵn sàng. Video chỉ bắt đầu sau khi bạn bấm “Tạo video”.</p><label class="script-count">Số đoạn<select class="script-scene-count">${Array.from({length:settings.max_scenes},(_,i)=>`<option value="${i+1}" ${job.scene_count===i+1?'selected':''}>${i+1} đoạn</option>`).join('')}</select></label><p class="script-total">${job.scene_count} đoạn × 10 giây = ${job.scene_count*10} giây</p>${plan.map(scene=>`<label class="script-line">Đoạn ${scene.index} · 10 giây<textarea class="script-dialogue" data-index="${scene.index}" rows="3" maxlength="600">${safe(scene.dialogue)}</textarea><small>Giọng miền Nam tự nhiên, nói vừa 10 giây và có nhịp nghỉ.</small></label>`).join('')}<p class="script-note" role="status">Lời thoại đã lưu. Bạn có thể sửa trước khi tạo video.</p><div class="script-actions"><button class="outline save-script" type="button">Lưu kịch bản</button><button class="outline replan-script" type="button" hidden>Cập nhật kịch bản</button><button class="primary approve-script" type="button">Tạo video</button></div>`;
  card.querySelector('.job-main').append(editor);
  const actor=()=>createClient(supabaseUrl,supabaseKey,{global:{headers:{Authorization:'Bearer '+session.access_token}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const count=editor.querySelector('.script-scene-count'),note=editor.querySelector('.script-note');
  const videoButton=editor.querySelector('.approve-script'),replanButton=editor.querySelector('.replan-script');
  const lines=()=>[...editor.querySelectorAll('.script-dialogue')].map(field=>field.value);
  const current=()=>session?.user.id===userId&&editor.isConnected;
  const updateCount=()=>{
    const chosen=Number(count.value),changed=chosen!==job.scene_count;
    editor.querySelector('.script-total').textContent=`${chosen} đoạn × 10 giây = ${chosen*10} giây`;
    replanButton.hidden=!changed;replanButton.textContent=`Cập nhật kịch bản ${chosen} đoạn`;
    videoButton.disabled=changed;
    if(changed)note.textContent='Số đoạn đã đổi. Cần tạo lại kịch bản trước khi tạo video.';
  };
  let saveTimer=null,operation=Promise.resolve();
  const commit=(submit=false)=>{
    const snapshot=lines();
    operation=operation.catch(()=>{}).then(async()=>{
      if(!current())return;
      if(Number(count.value)!==job.scene_count)throw Error('Số đoạn đã đổi. Hãy cập nhật lại kịch bản.');
      snapshot.forEach((line,i)=>validateEditedDialogue(line,i+1));
      editor.dataset.busy='true';
      const response=await actor().rpc('commit_brand_script_v3',{p_id:job.id,p_revision:Number(editor.dataset.revision),p_scene_count:job.scene_count,p_dialogues:snapshot,p_submit:submit});
      if(response.error)throw response.error;
      if(!current())return;
      editor.dataset.revision=String(response.data.script_revision);
      editor.dataset.dirty=JSON.stringify(lines())===JSON.stringify(snapshot)?'false':'true';
      note.textContent=submit?'Đã duyệt lời thoại; video đang chờ xử lý.':editor.dataset.dirty==='false'?'Đã lưu lời thoại.':'Đang lưu bản sửa tiếp theo…';
      return response.data;
    }).finally(()=>{if(editor.isConnected)editor.dataset.busy='false';});
    return operation;
  };
  const explain=error=>{if(current()){note.textContent=displayMessage(error.message)||'Không lưu được kịch bản.';message(note.textContent,'error');}};
  count.addEventListener('change',()=>{clearTimeout(saveTimer);updateCount();});
  editor.querySelectorAll('.script-dialogue').forEach(field=>field.addEventListener('input',()=>{
    editor.dataset.dirty='true';note.textContent='Đang chỉnh sửa…';clearTimeout(saveTimer);
    if(Number(count.value)===job.scene_count)saveTimer=setTimeout(()=>{
      try{lines().forEach((line,i)=>validateEditedDialogue(line,i+1));commit().catch(explain);}
      catch{note.textContent='Hoàn thiện lời thoại từng đoạn rồi lưu.';}
    },900);
  }));
  editor.querySelector('.save-script').addEventListener('click',async()=>{
    clearTimeout(saveTimer);try{await commit();}catch(error){explain(error);}
  });
  videoButton.addEventListener('click',async()=>{
    clearTimeout(saveTimer);editor.querySelectorAll('textarea,select,button').forEach(control=>control.disabled=true);editor.dataset.busy='true';
    try{const result=await commit(true);if(!current())return;if(result?.status!=='video_queued'&&result?.status!=='generating')throw Error('Chưa đưa được video vào hàng đợi.');editor.dataset.dirty='false';editor.dataset.busy='false';await refreshJobs({force:true});message('Đã lưu đúng lời thoại bạn duyệt và bắt đầu tạo video.','success');}
    catch(error){explain(error);if(current())videoButton.disabled=Number(count.value)!==job.scene_count;}
    finally{if(current()){editor.dataset.busy='false';editor.querySelectorAll('textarea,select,button').forEach(control=>control.disabled=false);videoButton.disabled=Number(count.value)!==job.scene_count;}}
  });
  replanButton.addEventListener('click',async()=>{
    clearTimeout(saveTimer);replanButton.disabled=true;editor.dataset.busy='true';
    try{await operation.catch(()=>{});if(!current())return;const result=await actor().rpc('replan_brand_script_v3',{p_id:job.id,p_revision:Number(editor.dataset.revision),p_scene_count:Number(count.value)});if(result.error)throw result.error;editor.dataset.dirty='false';editor.dataset.busy='false';await refreshJobs({force:true});message('Đã yêu cầu viết lại kịch bản theo số đoạn mới. Chưa tạo video.','success');}
    catch(error){explain(error);if(current())replanButton.disabled=false;}
    finally{if(current())editor.dataset.busy='false';}
  });
}

async function refreshJobs({force=false}={}) {
  if(!session||!document.querySelector('#jobs-list'))return;
  if(!force&&[...document.querySelectorAll('.script-editor')].some(editor=>editor.contains(document.activeElement)||editor.dataset.dirty==='true'||editor.dataset.busy==='true'))return;
  const userId=session.user.id,version=++jobsRefreshVersion;
  const result=await supabase.from('brand_jobs').select('id,user_id,content,scene_count,scene_seconds,creation_mode,storage_provider,reference_storage_provider,final_probe,status,current_scene,reference_path,reference_expires_at,reference_sha256,final_path,output_expires_at,retention_status,retention_attempts,retention_next_attempt_at,error,error_code,retryable,attempt,max_attempts,schema_version,workflow_phase,script_revision,allow_summarize,plan,created_at,brand_scenes(scene_index,prompt,dialogue,action,planned_seconds,status,submission_state,request_receipt,output_path,output_expires_at,error,error_code,generation)',{count:'exact'}).eq('user_id',userId).order('created_at',{ascending:false}).order('id',{ascending:false}).range(0,jobsVisibleCount-1);
  const list=document.querySelector('#jobs-list');if(!list||session?.user.id!==userId||version!==jobsRefreshVersion)return;
  if(!force&&[...list.querySelectorAll('.script-editor')].some(editor=>editor.contains(document.activeElement)||editor.dataset.dirty==='true'||editor.dataset.busy==='true'))return;
  if(result.error){list.textContent='Không tải được lịch sử: '+displayMessage(result.error.message);updateJobsPagination();return;}
  jobsTotalCount=result.count??result.data.length;updateJobsPagination();
  if(sceneRetryAvailable===null&&result.data.some(job=>job.status==='error'&&job.schema_version===3&&job.brand_scenes?.some(scene=>['MUSE_OUTPUT_REJECTED','SCENE_MEDIA_INVALID','CUT_OFF_SPEECH','SPEECH_TOO_SHORT','SPEECH_TIMING','SPEECH_MISMATCH','UNEXPECTED_SPEECH'].includes(scene.error_code)))){
    const probe=await supabase.rpc('retry_brand_scene_v3',{p_id:'00000000-0000-0000-0000-000000000000',p_scene:0});
    sceneRetryAvailable=probe.error?.message==='Không tìm thấy yêu cầu';
  }
  if(session?.user.id!==userId||version!==jobsRefreshVersion)return;
  const signature=JSON.stringify([sceneRetryAvailable,jobsTotalCount,result.data]);
  if(signature===jobsSignature)return;
  jobsSignature=signature;
  if(!result.data.length){list.innerHTML='<div class="empty"><strong>Chưa có kết quả nào</strong></div>';return;}
  // Other jobs can advance while a member watches or downloads a finished MP4.
  // Keep that player and its event listeners across the list refresh.
  const openMedia=new Map([...list.querySelectorAll('.video-slot')].filter(slot=>{
    if(!slot.querySelector('video,img'))return false;
    const job=result.data.find(item=>slot.id===`video-${item.id}`||slot.id.startsWith(`video-${item.id}-scene-`));
    if(!job)return false;
    const sceneIndex=Number(slot.id.match(/-scene-(\d+)$/)?.[1]);
    const scene=sceneIndex?job.brand_scenes?.find(item=>item.scene_index===sceneIndex):null;
    return mediaStillAvailable(job.retention_status,scene?scene.output_expires_at:job.output_expires_at);
  }).map(slot=>[slot.id,slot]));
  const status={uploading:'Đang chờ ảnh',queued:'Đang chờ',script_queued:'Chờ tạo kịch bản',planning:'Đang viết kịch bản',script_ready:'Chờ bạn duyệt',video_queued:'Chờ tạo video',generating:'Đang tạo video',joining:'Đang ghép video',done:'Hoàn tất',error:'Lỗi',needs_review:'Lỗi',reviewed:'Lỗi'};
  list.innerHTML=result.data.map(job=>{
    const scriptNeedsRetry=job.status==='error'&&job.schema_version===3&&job.workflow_phase==='script'&&!job.plan?.length;
    const singleVideo=job.brand_scenes?.some(isSingleMediaScene)||job.plan?.some(isSingleMediaScene);
    const isImage=job.creation_mode==='image',mediaName=isImage?'ảnh':'video';
    const firstScene=job.brand_scenes?.find(scene=>scene.scene_index===1);
    const displayError=job.error_code==='CONTENT_TOO_LONG'?'Chưa cô đọng được bản thô ở lượt trước. Hãy tạo lại kịch bản; hệ thống sẽ giữ ý chính và lược chi tiết phụ.':job.error;
    const finalActions=canDownloadFinal(job)?`<button class="outline view-video" data-kind="${isImage?'image':'video'}" data-path="${safe(job.final_path)}" data-id="${safe(job.id)}" data-retention="${safe(job.retention_status||'legacy')}" data-expiry="${safe(job.output_expires_at||'')}">Xem ${mediaName}</button><a class="primary download-final download-file" role="button" tabindex="0" aria-disabled="true" data-path="${safe(job.final_path)}" data-id="${safe(job.id)}" data-retention="${safe(job.retention_status||'legacy')}" data-expiry="${safe(job.output_expires_at||'')}">Đang chuẩn bị…</a>`:'';
    const safeResume=hasUncertainSubmission(job);
    const statusLabel=singleVideo&&job.status==='generating'?(firstScene?.submission_state==='sent'?`Đang tạo ${mediaName}`:'Đang gửi yêu cầu'):singleVideo&&job.status==='planning'?'Đang gửi yêu cầu':singleVideo&&job.status==='joining'?'Đang lưu kết quả':status[job.status]||job.status;
    const otherAction=job.status==='uploading'?`<label class="outline">Chọn lại ảnh<input class="resume-file" type="file" accept="image/png,image/jpeg,image/webp" data-id="${safe(job.id)}"></label>`:job.status==='error'&&job.error_code==='MEDIA_TOO_LARGE'?`<button class="outline resume-oversize-job" type="button" data-id="${safe(job.id)}">Nhận lại kết quả</button>`:safeResume?`<button class="outline resume-uncertain-job" type="button" data-id="${safe(job.id)}">Tiếp tục kiểm tra</button>`:singleVideo&&job.status==='error'&&job.retryable?`<button class="outline retry-single-job" type="button" data-id="${safe(job.id)}">Gửi lại ${mediaName}</button>`:job.status==='error'&&job.retryable?`<button class="outline retry-job" type="button" data-id="${safe(job.id)}">${job.workflow_phase==='script'?'Tạo lại kịch bản':'Tạo lại video'}</button>`:'';
    const durationLabel=isImage?'1 ảnh · Tạo ảnh':job.creation_mode==='video_free'?`1 video · Video tự do${job.final_probe?.duration?` · ${Number(job.final_probe.duration).toFixed(1).replace(/\.0$/,'')} giây`:''}`:singleVideo?`1 video · ${job.scene_seconds} giây`:job.schema_version===3?`${job.scene_count} đoạn · ${job.scene_seconds} giây/đoạn · tổng ${job.scene_count*job.scene_seconds} giây`:`${job.scene_count} cảnh · ${job.scene_seconds} giây/cảnh · tổng ${job.scene_count*job.scene_seconds} giây`;
    const track=scriptNeedsRetry?'':singleVideo?'':`<div class="scene-track">${Array.from({length:job.scene_count},(_,i)=>{const scene=job.brand_scenes?.find(x=>x.scene_index===i+1);return `<span class="scene-pill ${safe(scene?.status||'waiting')}">${String(i+1).padStart(2,'0')}</span>`;}).join('')}</div>`;
    const scriptDetails=singleVideo?'':job.brand_scenes?.length?`<details><summary>Lời thoại từng đoạn</summary>${job.brand_scenes.sort((a,b)=>a.scene_index-b.scene_index).map(scene=>`<p><strong>Đoạn ${scene.scene_index} · ${scene.planned_seconds||job.scene_seconds} giây</strong><br>Lời thoại: ${safe(scene.dialogue||'Không có')}</p>`).join('')}</details>`:'';
    return `<article class="job-card ${singleVideo?'single-video-job':''}" data-job-id="${safe(job.id)}"><div class="job-main"><div class="job-top"><span>${shortDate(job.created_at)}</span><span class="status status-${safe(job.status)}">${safe(scriptNeedsRetry?'Cần tạo lại kịch bản':statusLabel)}</span></div><div class="job-heading"><img class="job-thumbnail" alt="Ảnh tham chiếu" hidden><h3>${safe(job.content.slice(0,110))}</h3></div><p>${durationLabel}</p><small>Mã yêu cầu: ${safe(job.id)}</small>${displayError?`<p class="job-error">${safe(displayMessage(displayError))}</p>`:''}${retentionMarkup(job)}${scriptNeedsRetry?'<p class="inline-warning">Chưa có kịch bản nên chưa thể tạo video. Sửa nội dung rồi gửi lại yêu cầu.</p>':track}${scriptDetails}</div><div class="job-action">${finalActions}${otherAction}</div><div class="video-slot" id="video-${safe(job.id)}"></div></article>`;
  }).join('');
  result.data.forEach(async(job,index)=>{
    if(!job.reference_path)return;
    const thumbnail=list.children[index]?.querySelector('.job-thumbnail');if(!thumbnail)return;
    const ttl=job.reference_expires_at?Math.max(1,Math.floor((Date.parse(job.reference_expires_at)-Date.now())/1000)):3600;
    if(ttl<=0||!mediaStillAvailable(job.retention_status,job.reference_expires_at))return;
    let url;try{url=await signedMediaUrl(supabase,{provider:job.reference_storage_provider,bucket:'brand-references',path:job.reference_path,jobId:job.id,token:session.access_token,expiresIn:Math.min(3600,ttl)});}catch{return;}
    if(!thumbnail.isConnected||!mediaStillAvailable(job.retention_status,job.reference_expires_at))return;
    thumbnail.src=url;thumbnail.dataset.expiry=job.reference_expires_at||'';thumbnail.hidden=false;
  });
  result.data.forEach((job,i)=>{
    const track=list.children[i]?.querySelector('.scene-track');if(!track)return;
    const labels={waiting:'Chờ xử lý',generating:'Đang tạo',done:'Hoàn thành',error:'Thất bại',needs_review:'Cần kiểm tra'};
    track.classList.add('scene-progress');
    track.innerHTML=Array.from({length:job.scene_count},(_,index)=>{
      const scene=job.brand_scenes?.find(item=>item.scene_index===index+1),state=visibleSceneStatus(job,scene);
      const safeResume=hasUncertainSubmission(job)&&['sending','sent'].includes(scene?.submission_state)&&scene?.request_receipt;
      const singleVideo=job.brand_scenes?.some(isSingleMediaScene)||job.plan?.some(isSingleMediaScene);
      const stateLabel=safeResume?'Cần tiếp tục kiểm tra':singleVideo&&state==='generating'?(scene?.submission_state==='sent'?'Đang tạo video':'Đang gửi yêu cầu'):labels[state]||state;
      const slotId=`video-${job.id}-scene-${index+1}`;
      const sceneExpiry=scene?.output_expires_at||'';
      const sceneRemaining=sceneExpiry?Date.parse(sceneExpiry)-Date.now():null;
      const sceneTimer=sceneExpiry?`<small class="scene-expiry">Còn: <span class="scene-expiry-timer" data-expiry="${safe(sceneExpiry)}">${sceneRemaining>0?formatRemaining(sceneRemaining):'đang chờ máy chủ xác nhận xóa'}</span></small>`:'';
      const canResume=state==='error'&&job.status==='error'&&job.retryable&&!safeResume;
      const canRestart=sceneRetryAvailable&&state==='error'&&job.status==='error'&&job.schema_version===3&&!canResume&&['MUSE_OUTPUT_REJECTED','SCENE_MEDIA_INVALID','CUT_OFF_SPEECH','SPEECH_TOO_SHORT','SPEECH_TIMING','SPEECH_MISMATCH','UNEXPECTED_SPEECH'].includes(scene?.error_code);
      return `<div class="scene-row"><span class="scene-pill ${safe(state)}">${String(index+1).padStart(2,'0')}</span><span>${singleVideo?'Video':'Đoạn'} ${index+1}/${job.scene_count}: <strong>${safe(stateLabel)}</strong>${state==='generating'&&!singleVideo?` · lần ${Number(scene?.generation||0)%3+1}/3`:''}${state==='error'&&(scene?.error||safeResume)?`<small class="job-error">${safe(displayMessage(scene?.error||job.error||'Chưa tìm thấy yêu cầu đã gửi. Hãy tiếp tục kiểm tra; hệ thống sẽ không gửi clip trùng khi còn biên nhận.'))}</small>`:''}${state==='done'?sceneTimer:''}</span>${state==='done'&&scene.output_path&&mediaStillAvailable(job.retention_status,scene.output_expires_at)&&!singleVideo?`<button class="outline view-video view-scene" type="button" data-path="${safe(scene.output_path)}" data-id="${safe(job.id)}" data-scene="${index+1}" data-slot="${safe(slotId)}" data-retention="${safe(job.retention_status||'legacy')}" data-expiry="${safe(scene.output_expires_at||'')}">Xem đoạn</button>`:safeResume&&!singleVideo?`<button class="outline resume-uncertain-job" type="button" data-id="${safe(job.id)}">Tiếp tục kiểm tra</button>`:canResume&&!singleVideo?`<button class="outline retry-job" type="button" data-id="${safe(job.id)}">Tạo lại / tiếp tục đoạn ${index+1}</button>`:canRestart?`<button class="outline retry-scene" type="button" data-id="${safe(job.id)}" data-scene="${index+1}">Tạo lại đoạn ${index+1}</button>`:''}<div class="video-slot" id="${safe(slotId)}"></div></div>`;
    }).join('');
  });
  for(const [id,slot] of openMedia){
    const fresh=document.getElementById(id);
    if(!fresh)continue;
    const view=id.includes('-scene-')?fresh.closest('.job-card')?.querySelector(`.view-video[data-slot="${CSS.escape(id)}"]`):fresh.closest('.job-card')?.querySelector('.view-video:not([data-slot])');
    fresh.replaceWith(slot);
    if(view)view.hidden=true;
  }
  result.data.forEach((job,i)=>{if(job.schema_version===3&&job.status==='script_ready')renderScriptEditor(job,list.children[i],userId);});
  for(const job of result.data.filter(job=>job.status==='error'&&['CONTENT_INSUFFICIENT','CONTENT_TOO_LONG','STORYBOARD_INVALID'].includes(job.error_code))){
    const slot=document.getElementById('video-'+job.id)?.previousElementSibling;
    if(!slot)continue;
    const edit=document.createElement('button');edit.type='button';edit.className='outline edit-input';edit.textContent=job.error_code==='CONTENT_TOO_LONG'?'Tạo lại kịch bản':'Sửa nội dung / gửi lại';
    slot.append(edit);
    edit.addEventListener('click',async()=>{
      if(session?.user.id!==userId)return;
      edit.disabled=true;
      const actor=createClient(supabaseUrl,supabaseKey,{global:{headers:{Authorization:'Bearer '+session.access_token}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
      try{
        const image=await downloadMedia(actor,{provider:job.reference_storage_provider,bucket:'brand-references',path:job.reference_path,jobId:job.id,token:session.access_token});
        if(await fileHash(image)!==job.reference_sha256)throw Error('Ảnh đã lưu không khớp ảnh ban đầu.');
        if(session?.user.id!==userId||!edit.isConnected)return;
        const content=document.querySelector('#content'),reference=document.querySelector('#reference');if(!content||!reference)return;
        content.value=job.content;
        const files=new DataTransfer();files.items.add(new File([image],'anh-tham-chieu',{type:image.type}));reference.files=files.files;
        reference.dispatchEvent(new Event('change'));content.dispatchEvent(new Event('input'));
        document.querySelector('#brand').scrollIntoView({behavior:'smooth'});
        message('Đã điền lại ảnh và yêu cầu. Kiểm tra nội dung rồi bấm “Gửi” để tạo một video mới.','info');
      }catch(error){if(session?.user.id===userId)message('Không tải lại được ảnh: '+error.message,'error');}
      finally{if(edit.isConnected)edit.disabled=false;}
    });
  }
  list.querySelectorAll('.resume-file').forEach(input=>input.addEventListener('change',async()=>{
    let file=input.files[0];const job=result.data.find(item=>item.id===input.dataset.id);
    if(!file||!job||input.disabled||session?.user.id!==userId)return;
    input.disabled=true;
    try{
      if(await fileHash(file)!==job.reference_sha256&&job.creation_mode==='video_10s')file=(await normalizeReferenceImage(file)).file;
      if(await fileHash(file)!==job.reference_sha256)throw Error('Ảnh không khớp ảnh đã chọn ban đầu. Hãy chọn lại ảnh gốc trên thiết bị đã gửi yêu cầu.');
      if(session?.user.id!==userId||!input.isConnected)return;
      const token=session.access_token,actor=createClient(supabaseUrl,supabaseKey,{global:{headers:{Authorization:'Bearer '+token}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
      try{await uploadMedia(actor,{provider:job.reference_storage_provider,bucket:'brand-references',path:job.reference_path,jobId:job.id,token,contentType:file.type,data:file});}
      catch(error){if(job.reference_storage_provider==='r2')throw error;const old=await actor.storage.from('brand-references').download(job.reference_path);if(old.error||await fileHash(old.data)!==job.reference_sha256)throw error;}
      if(session?.user.id!==userId||!input.isConnected)return;
      const queued=await actor.rpc('queue_brand_job',{p_id:job.id});if(queued.error)throw queued.error;
      message('Đã đưa yêu cầu vào hàng chờ.','success');await refreshJobs();
    }catch(error){if(session?.user.id===userId)message(error.message,'error');}
    finally{if(input.isConnected)input.disabled=false;}
  }));
  list.querySelectorAll('.resume-oversize-job').forEach(button=>button.addEventListener('click',async()=>{
    const id=button.dataset.id;if(retryingJobs.has(id))return;retryingJobs.add(id);button.disabled=true;
    try{const result=await supabase.rpc('resume_oversize_job_in_r2',{p_id:id});if(result.error)throw result.error;message('Đang nhận lại kết quả đã tạo, không gửi yêu cầu mới.','success');}
    catch(error){message(error.message||'Chưa thể nhận lại kết quả.','error');}
    finally{retryingJobs.delete(id);if(session?.user.id===userId)await refreshJobs({force:true});if(button.isConnected)button.disabled=false;}
  }));
  list.querySelectorAll('.retry-job').forEach(button=>button.addEventListener('click',async()=>{
    const id=button.dataset.id;if(retryingJobs.has(id))return;retryingJobs.add(id);
    list.querySelectorAll('.retry-job').forEach(item=>{if(item.dataset.id===id)item.disabled=true;});
    try{
      const result=await supabase.rpc('retry_brand_job',{p_id:id});if(result.error)throw result.error;
      message('Đã xếp lại đúng tác vụ lỗi. Các đoạn đã hoàn thành được giữ nguyên.','success');
    }catch(error){message(error.message||'Không thể xếp lại tác vụ. Hãy tải lại trạng thái rồi thử lại.','error');}
    finally{retryingJobs.delete(id);if(session?.user.id===userId)await refreshJobs({force:true});if(button.isConnected)button.disabled=false;}
  }));
  list.querySelectorAll('.retry-single-job').forEach(button=>button.addEventListener('click',async()=>{
    const id=button.dataset.id;if(retryingJobs.has(id))return;retryingJobs.add(id);
    list.querySelectorAll('.retry-single-job').forEach(item=>{if(item.dataset.id===id)item.disabled=true;});
    try{
      const result=await supabase.rpc('retry_single_media_job',{p_id:id});if(result.error)throw result.error;
      message('Đã gửi lại một yêu cầu duy nhất bằng đúng chế độ, ảnh và mô tả ban đầu.','success');
    }catch(error){message(error.message||'Không thể gửi lại video. Hãy tải lại trạng thái rồi thử lại.','error');}
    finally{retryingJobs.delete(id);if(session?.user.id===userId)await refreshJobs({force:true});if(button.isConnected)button.disabled=false;}
  }));
  list.querySelectorAll('.resume-uncertain-job').forEach(button=>button.addEventListener('click',async()=>{
    const id=button.dataset.id;if(retryingJobs.has(id))return;retryingJobs.add(id);
    list.querySelectorAll('.resume-uncertain-job').forEach(item=>{if(item.dataset.id===id)item.disabled=true;});
    try{
      const result=await supabase.rpc('resume_uncertain_brand_job',{p_id:id});if(result.error)throw result.error;
      message('Đã xếp tác vụ vào hàng đợi để kiểm tra yêu cầu đã gửi. Biên nhận được giữ lại; không tạo clip trùng.','success');
    }catch(error){message(error.message||'Không thể tiếp tục kiểm tra. Hãy tải lại trạng thái rồi thử lại.','error');}
    finally{retryingJobs.delete(id);if(session?.user.id===userId)await refreshJobs({force:true});if(button.isConnected)button.disabled=false;}
  }));
  list.querySelectorAll('.retry-scene').forEach(button=>button.addEventListener('click',async()=>{
    const id=button.dataset.id,scene=Number(button.dataset.scene),key=`${id}:${scene}`;if(retryingScenes.has(key))return;retryingScenes.add(key);button.disabled=true;
    try{
      const result=await supabase.rpc('retry_brand_scene_v3',{p_id:id,p_scene:scene});if(result.error)throw result.error;
      message(`Đã xếp lại đoạn ${scene}; các đoạn hoàn tất được giữ nguyên.`,'success');
    }catch(error){message(error.message||'Không thể xếp lại đoạn video. Hãy tải lại trạng thái rồi thử lại.','error');}
    finally{retryingScenes.delete(key);if(session?.user.id===userId)await refreshJobs({force:true});if(button.isConnected)button.disabled=false;}
  }));
  list.querySelectorAll('.download-final').forEach(link=>prepareDownloadLink(link,{path:link.dataset.path,id:link.dataset.id,userId,provider:result.data.find(job=>job.id===link.dataset.id)?.storage_provider,retentionStatus:link.dataset.retention,expiresAt:link.dataset.expiry||null}));
  list.querySelectorAll('.view-video').forEach(button=>button.addEventListener('click',async()=>{
    if(!mediaStillAvailable(button.dataset.retention,button.dataset.expiry||null)){message('File đã hết hạn hoặc đang được xóa.','error');refreshJobs({force:true});return;}
    button.disabled=true;
    const ttl=button.dataset.expiry?Math.max(1,Math.floor((Date.parse(button.dataset.expiry)-Date.now())/1000)):3600;
    const provider=result.data.find(job=>job.id===button.dataset.id)?.storage_provider;
    let url;try{url=await signedMediaUrl(supabase,{provider,bucket:'brand-videos',path:button.dataset.path,jobId:button.dataset.id,token:session.access_token,expiresIn:Math.min(3600,ttl)});}catch(error){message(error.message,'error');button.disabled=false;return;}
    if(session?.user.id!==userId||!button.isConnected)return;
    if(!mediaStillAvailable(button.dataset.retention,button.dataset.expiry||null)){message('File đã hết hạn trong lúc mở.','error');refreshJobs({force:true});return;}
    const slot=document.getElementById(button.dataset.slot||`video-${button.dataset.id}`);
    if(!slot){button.disabled=false;return;}
    const isImage=button.dataset.kind==='image';
    slot.innerHTML=`${isImage?`<img class="result-image" alt="Ảnh đã tạo từ yêu cầu của bạn" src="${safe(url)}">`:`<video controls playsinline src="${safe(url)}"></video>`}<a class="outline download-video download-file" role="button" tabindex="0" aria-disabled="true" data-label="${isImage?'Tải ảnh':'Tải MP4'}">Đang chuẩn bị…</a>`;button.hidden=true;
    prepareDownloadLink(slot.querySelector('.download-video'),{path:button.dataset.path,id:button.dataset.id,scene:button.dataset.scene,userId,provider,retentionStatus:button.dataset.retention,expiresAt:button.dataset.expiry||null});
  }));
}

function renderAdmin() {
  document.querySelector('#admin').innerHTML=`<div class="section-head"><div><p class="eyebrow">DÀNH CHO QUẢN TRỊ</p><h2>Cài đặt & thành viên</h2></div><span class="section-note">Chỉ quản trị viên có quyền thay đổi</span></div><div class="admin-grid"><form id="settings-form" class="admin-card"><h3>Cài đặt tạo video</h3><label class="toggle"><input id="enabled" type="checkbox" ${settings.enabled?'checked':''}><span>Nhận yêu cầu mới</span></label><label>Lượt mỗi thành viên/ngày<input id="daily-limit" type="number" min="1" max="30" value="${settings.daily_limit}"></label><p class="admin-note">Mỗi yêu cầu tạo một video. Hệ thống tự chọn thời lượng trong các chế độ đang bật. Máy xử lý cần được kết nối và chạy để xử lý hàng đợi.</p><button class="primary" type="submit">Lưu cài đặt</button></form><div class="admin-card"><h3>Thành viên</h3><div id="member-list" class="mini-list">Đang tải…</div></div><div class="admin-card full-width"><h3>Tác vụ cần kiểm tra</h3><div id="review-list" class="mini-list">Đang tải…</div></div></div>`;
  document.querySelector('#admin .admin-grid').insertAdjacentHTML('afterbegin',`<div class="admin-card system-control"><h3>Hệ thống xử lý</h3><p id="system-state" class="system-state" role="status">Đang kiểm tra kết nối máy…</p><p id="system-detail" class="admin-note">Máy xử lý cần bật và đăng nhập Windows.</p><button id="start-system" class="primary" type="button" disabled>Khởi động hệ thống</button><p id="system-feedback" class="admin-note" aria-live="polite"></p></div>`);
  on('#start-system','click',async event=>{
    if(controlStarting)return;
    controlStarting=true;event.currentTarget.disabled=true;
    const feedback=document.querySelector('#system-feedback');if(feedback)feedback.textContent='Đang gửi lệnh khởi động…';
    try{
      const {error}=await supabase.rpc('muse_control_start');if(error)throw error;
      if(feedback?.isConnected)feedback.textContent='Đã gửi lệnh. Hệ thống đang kiểm tra và khởi động các thành phần cần thiết.';
    }catch(error){if(feedback?.isConnected)feedback.textContent=displayMessage(error.message)||'Không gửi được lệnh. Hãy kiểm tra kết nối.';}
    finally{controlStarting=false;await refreshControlStatus();}
  });
  on('#settings-form','submit',async event=>{
    event.preventDefault();const values={enabled:document.querySelector('#enabled').checked,daily_limit:Number(document.querySelector('#daily-limit').value),updated_at:new Date().toISOString()};
    const {error}=await supabase.from('app_settings').update(values).eq('id',true);if(error)return message(error.message,'error');settings={...settings,...values};message('Đã lưu cài đặt.','success');renderModule();
  });
  refreshAdmin();
}

async function refreshControlStatus(){
  if(controlStatusLoading||profile?.role!=='admin'||!profile.approved||!document.querySelector('#system-state'))return;
  controlStatusLoading=true;const userId=session?.user.id;
  try{
    const {data,error}=await supabase.rpc('muse_control_status');
    if(session?.user.id!==userId||!document.querySelector('#system-state'))return;
    const state=document.querySelector('#system-state'),detail=document.querySelector('#system-detail'),button=document.querySelector('#start-system');
    if(error){state.textContent='Chưa kết nối chức năng điều khiển';detail.textContent='Cần cập nhật hệ thống trước khi khởi động từ web.';button.disabled=true;return;}
    const messages={
      ready:['Sẵn sàng','Hệ thống đã kết nối và có thể nhận yêu cầu.'],
      waiting_admin_login:['Cần đăng nhập quản trị trên máy','Mở 03-DANG-NHAP.cmd trên máy xử lý và đăng nhập một lần.'],
      waiting_muse_login:['Cần kiểm tra kết nối','Kiểm tra cửa sổ dịch vụ tạo nội dung trên máy và đăng nhập lại nếu được yêu cầu.'],
      waiting_worker_lease:['Đang chờ worker khác','Hệ thống chờ worker đang hoạt động hoàn tất hoặc nhường quyền.'],
      waiting_docker:['Đang khởi động Docker','Hệ thống đang chờ Docker sẵn sàng.'],
      waiting_asr:['Đang chuẩn bị dịch vụ','Hệ thống đang kiểm tra dịch vụ phụ trợ.'],
      asr_container_missing:['Thiếu dịch vụ phụ trợ','Không tìm thấy dịch vụ nhận dạng giọng nói trên máy.'],
      waiting_setup:['Đang cài đặt','Vui lòng chờ quá trình cài đặt hoặc đăng nhập hoàn tất.'],
      checking_tools:['Đang kiểm tra hệ thống','Đang kiểm tra các thành phần cần thiết.'],
      starting_worker:['Đang khởi động','Đang mở các thành phần xử lý trên máy.'],
      waiting_retry:['Đang thử kết nối lại','Hệ thống sẽ tự kiểm tra và thử lại.'],
      error:['Không thể khởi động','Kiểm tra thông báo trên máy xử lý.'],
      stopped:['Đã dừng','Bộ điều khiển trên máy đã dừng.']
    };
    const pair=!data?.paired?['Chưa kết nối máy','Cần đăng nhập quản trị một lần trên máy xử lý để kết nối.']:
      !data.online?['Máy chưa kết nối','Bật máy xử lý và đăng nhập Windows; không thể khởi động máy đã tắt từ web.']:
      messages[data.state]||['Đang kiểm tra','Hệ thống đang cập nhật trạng thái.'];
    state.textContent=pair[0];detail.textContent=pair[1];button.disabled=controlStarting||!data?.online;
  }catch{const detail=document.querySelector('#system-detail');if(detail)detail.textContent='Không kiểm tra được kết nối. Hãy thử lại.';}
  finally{controlStatusLoading=false;}
}

async function refreshAdmin() {
  if(profile?.role!=='admin'||!document.querySelector('#member-list'))return;
  void refreshControlStatus();
  const userId=session.user.id;
  const [members,jobs]=await Promise.all([
    supabase.from('profiles').select('id,email,role,approved,created_at').order('created_at',{ascending:false}),
    supabase.from('brand_jobs').select('id,content,user_id,error,error_code,retryable,attempt,max_attempts,schema_version,created_at').in('status',['needs_review','error']).order('created_at',{ascending:false})
  ]);
  if(session?.user.id!==userId||profile?.role!=='admin'||!document.querySelector('#member-list'))return;
  const memberList=document.querySelector('#member-list');
  memberList.innerHTML=members.error?`<p>${safe(displayMessage(members.error.message))}</p>`:members.data.filter(user=>user.role==='member').map(user=>`<div class="mini-row"><div><strong>${safe(user.email)}</strong><small>${user.approved?'Đang hoạt động':'Chờ duyệt'}</small></div><button class="outline approve-user" data-id="${safe(user.id)}" data-next="${!user.approved}">${user.approved?'Tạm khóa':'Duyệt'}</button></div>`).join('')||'<p>Chưa có thành viên.</p>';
  memberList.querySelectorAll('.approve-user').forEach(button=>button.addEventListener('click',async()=>{const {error}=await supabase.from('profiles').update({approved:button.dataset.next==='true'}).eq('id',button.dataset.id);if(error)return message(error.message,'error');await refreshAdmin();}));
  const reviewList=document.querySelector('#review-list');
  reviewList.innerHTML=jobs.error?`<p>${safe(displayMessage(jobs.error.message))}</p>`:jobs.data.map(job=>`<div class="mini-row"><div><strong>${safe(job.content.slice(0,120))}</strong><small>${shortDate(job.created_at)} · ${safe(displayMessage(job.error||'Cần kiểm tra kết quả'))}</small></div>${job.schema_version===2?(job.retryable&&job.attempt<job.max_attempts?`<button class="outline retry-admin-job" data-id="${safe(job.id)}">Thử lại</button>`:'<small>Cần kiểm tra nguyên nhân trước khi tạo yêu cầu mới.</small>'):`<button class="outline review-job" data-id="${safe(job.id)}">Đã kiểm tra</button>`}</div>`).join('')||'<p>Không có tác vụ cần kiểm tra.</p>';
  reviewList.querySelectorAll('.retry-admin-job').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;const {error}=await supabase.rpc('retry_brand_job',{p_id:button.dataset.id});if(error)message(error.message,'error');await refreshAdmin();await refreshJobs();}));
  reviewList.querySelectorAll('.review-job').forEach(button=>button.addEventListener('click',async()=>{if(!window.confirm('Bạn đã xem kết quả và xác nhận không còn tác vụ đang chạy?'))return;const {error}=await supabase.rpc('review_legacy_brand_job',{p_id:button.dataset.id});if(error)return message(error.message,'error');await refreshAdmin();await refreshJobs();}));
}

async function loadApp() {
  const epoch=++appEpoch;
  showLoading();
  const result=await supabase.auth.getSession();if(epoch!==appEpoch)return;session=result.data.session;
  if(!session){authView();return;}
  if(location.pathname==='/oauth/consent'){
    clearInterval(poller);clearInterval(retentionClock);
    await renderConsent({root,client:supabase,userId:session.user.id,authorizationId:new URL(location.href).searchParams.get('authorization_id')});return;
  }
  try {if(!await loadProfile(session.user.id)||epoch!==appEpoch)return;shell();clearInterval(poller);poller=setInterval(()=>{refreshJobs();if(profile?.role==='admin')refreshAdmin();},7000);}
  catch(error){if(epoch!==appEpoch)return;root.innerHTML=`<main class="fatal"><h1>Không mở được không gian làm việc</h1><p>${safe(displayMessage(error.message))}</p><button class="primary" id="retry-app">Thử lại</button></main>`;on('#retry-app','click',loadApp);}
}

if(!supabase)root.innerHTML='<main class="fatal"><h1>Chưa cấu hình web</h1><p>Cần đặt VITE_SUPABASE_PUBLISHABLE_KEY khi triển khai.</p></main>';
else {supabase.auth.onAuthStateChange((_event,newSession)=>{if(newSession?.user?.id!==session?.user?.id){appEpoch++;session=newSession;profile=null;settings=null;modes=[];clearInterval(poller);showLoading();setTimeout(loadApp,0);}else session=newSession;});loadApp();}
