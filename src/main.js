import {createClient} from '@supabase/supabase-js';
import {adminEmail, supabaseKey, supabaseUrl} from './config.js';
import {storyboardInput} from '../shared/storyboard.mjs';
import {validateEditedDialogue} from '../shared/brand-video-prompt.mjs';
import './styles.css';
import './brand-script.css';

const root = document.querySelector('#app');
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const shortDate = value => new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
const labels = {uploading:'Đang tải ảnh',queued:'Đang xếp hàng',planning:'AI chia cảnh',generating:'Đang tạo cảnh',joining:'Đang ghép',done:'Hoàn tất',needs_review:'Cần kiểm tra',reviewed:'Đã kiểm tra'};
let session = null, profile = null, settings = null, modes = [], poller = null, previewUrl = null, jobsSignature = '', appEpoch = 0, jobsRefreshVersion = 0, sceneRetryAvailable = null, jobsVisibleCount = 3, jobsTotalCount = 0, retentionClock = null;
const retentionExpiredRefreshes=new Set();

function message(text, type='info') {
  const box = document.querySelector('#notice');
  if (box) {box.textContent=text; box.className='notice '+type; box.hidden=false;}
}
function clearMessage() { const box=document.querySelector('#notice'); if(box) box.hidden=true; }
function on(selector,event,handler) { document.querySelector(selector)?.addEventListener(event,handler); }
function showLoading() { root.innerHTML='<main class="loading"><span class="spinner"></span><p>Đang mở không gian sáng tạo…</p></main>'; }

function authView(mode='login') {
  clearInterval(poller);
  clearInterval(retentionClock);
  root.innerHTML=`<div class="auth-layout"><div class="auth-art"><div class="brandmark">M<span>•</span></div><p class="eyebrow">MUSE STUDIO</p><h1>Từ ý tưởng<br>đến thước phim.</h1><p>Một không gian để thành viên tạo video theo từng cảnh, theo dõi tiến độ và lấy bản hoàn chỉnh.</p><div class="art-lines"><i></i><i></i><i></i></div></div><main class="auth-panel"><div class="auth-box"><p class="eyebrow">TÀI KHOẢN</p><h2>${mode==='signup'?'Tạo tài khoản':'Chào mừng trở lại'}</h2><p class="muted">${mode==='signup'?'Đăng ký bằng email. Quản trị viên sẽ duyệt trước khi bạn tạo video.':'Đăng nhập để tiếp tục sáng tạo.'}</p><form id="auth-form"><label>Email<input id="auth-email" type="email" autocomplete="email" required></label><label>Mật khẩu<input id="auth-password" type="password" autocomplete="${mode==='signup'?'new-password':'current-password'}" minlength="12" required></label><button class="primary full" type="submit">${mode==='signup'?'Đăng ký':'Đăng nhập'} <span aria-hidden="true">↗</span></button></form><div id="notice" class="notice" hidden role="status"></div><button id="switch-auth" class="text-button">${mode==='signup'?'Đã có tài khoản? Đăng nhập':'Chưa có tài khoản? Đăng ký'}</button></div></main></div>`;
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
  root.innerHTML=`<div class="app-shell"><aside class="sidebar"><a class="wordmark" href="#home" aria-label="Muse Studio, trang chủ"><span class="brandmark small">M<span>•</span></span><span>Muse Studio</span></a><div class="side-caption">KHÔNG GIAN LÀM VIỆC</div><nav aria-label="Điều hướng"><a class="nav-item active" href="#home"><span aria-hidden="true">▦</span> Ứng dụng</a><a class="nav-item" href="#jobs"><span aria-hidden="true">◷</span> Video của tôi</a>${isAdmin?'<a class="nav-item" href="#admin"><span aria-hidden="true">⚙</span> Quản trị</a>':''}</nav><div class="side-bottom"><span class="avatar">${safe((profile?.email||'U')[0].toUpperCase())}</span><div><strong>${safe(profile?.email||session.user.email)}</strong><small>${isAdmin?'Quản trị viên':profile?.approved?'Thành viên':'Chờ duyệt'}</small></div></div></aside><div class="main-column"><header class="topbar"><button class="mobile-brand" id="menu-toggle" aria-label="Mở điều hướng">☰</button><span class="top-location">Không gian sáng tạo <b>/</b> Ứng dụng</span><button class="outline small-button" id="signout">Đăng xuất</button></header><main class="workspace"><div id="notice" class="notice" hidden role="status"></div><section class="intro"><div><p class="eyebrow">WORKSPACE / 01</p><h1>Chọn công cụ,<br><em>tạo điều bạn tưởng tượng.</em></h1><p>Hình ảnh và chuyển động của thương hiệu, cùng trong một quy trình rõ ràng.</p></div><div class="intro-counter"><span>01</span><small>công cụ đang hoạt động</small></div></section><section class="tools" id="home" aria-labelledby="tools-title"><div class="section-head"><div><p class="eyebrow">BỘ CÔNG CỤ</p><h2 id="tools-title">Ứng dụng sáng tạo</h2></div><span class="section-note">4 công cụ / hàng trên màn hình rộng</span></div><div class="tool-grid"><button class="tool-card selected" id="open-brand"><span class="tool-icon amber">◈</span><span class="tool-number">01 / VIDEO</span><strong>Tạo thương hiệu</strong><span class="tool-desc">Từ một ảnh tham chiếu đến video nhiều cảnh.</span><span class="tool-link">Mở công cụ <b>↗</b></span></button><div class="tool-card unavailable"><span class="tool-icon jade">▤</span><span class="tool-number">02 / VIDEO</span><strong>Văn bản thành video</strong><span class="tool-desc">Tạo đoạn phim từ mô tả ngắn.</span><span class="coming">Sắp có</span></div><div class="tool-card unavailable"><span class="tool-icon blue">▧</span><span class="tool-number">03 / VIDEO</span><strong>Ảnh thành video</strong><span class="tool-desc">Biến khung hình thành chuyển động.</span><span class="coming">Sắp có</span></div><div class="tool-card unavailable"><span class="tool-icon rose">✳</span><span class="tool-number">04 / HÌNH ẢNH</span><strong>Tạo ảnh</strong><span class="tool-desc">Thiết kế hình ảnh cho ý tưởng mới.</span><span class="coming">Sắp có</span></div></div></section><section id="brand" class="module"></section><section id="jobs" class="jobs-section"></section>${isAdmin?'<section id="admin" class="admin-section"></section>':''}</main></div></div>`;
  on('#signout','click',async()=>{await supabase.auth.signOut();session=null;profile=null;authView();});
  on('#menu-toggle','click',()=>document.querySelector('.sidebar').classList.toggle('open'));
  on('#open-brand','click',()=>document.querySelector('#brand').scrollIntoView({behavior:'smooth'}));
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
  section.innerHTML=`<div class="section-head module-head"><div><p class="eyebrow">CÔNG CỤ 01</p><h2>Tạo thương hiệu</h2><p>Một ảnh nhất quán. Nhiều cảnh, một câu chuyện.</p></div><span class="step-badge">01 — ${String(settings.max_scenes).padStart(2,'0')} CẢNH</span></div><div class="creator-layout"><form id="create-form" class="creator-form"><div class="form-header"><span class="form-index">01</span><div><h3>Thiết lập video</h3><p>AI Muse sẽ phân tích ý tưởng và lập từng cảnh trước khi tạo.</p></div></div><label class="field-label" for="reference">Ảnh tham chiếu <span>Bắt buộc</span></label><label class="upload-zone" for="reference"><input id="reference" type="file" accept="image/png,image/jpeg,image/webp" required><span class="upload-symbol">↥</span><strong id="file-name">Chọn hoặc kéo ảnh vào đây</strong><small>JPG, PNG hoặc WebP · tối đa 10 MB</small><img id="image-preview" alt="Ảnh tham chiếu đã chọn" hidden></label><label class="field-label" for="content">Nội dung thương hiệu <span>Bắt buộc</span></label><textarea id="content" rows="6" minlength="10" maxlength="4000" required placeholder="Ví dụ: Giới thiệu sản phẩm cà phê rang mộc. Tông màu ấm, nhịp kể chậm, thể hiện quy trình từ hạt đến tách cà phê."></textarea><div class="form-row"><label class="field-label" for="scene-count">Số cảnh muốn tạo<select id="scene-count">${Array.from({length:settings.max_scenes},(_,i)=>`<option value="${i+1}" ${i+1===Math.min(3,settings.max_scenes)?'selected':''}>${i+1} cảnh</option>`).join('')}</select></label><div class="duration-box"><span>Thời lượng mỗi cảnh</span><strong>${settings.scene_seconds} giây</strong><small>Quản trị viên cài đặt</small></div></div><p class="consent"><span aria-hidden="true">ⓘ</span> Ảnh và mô tả được gửi qua tài khoản Muse của đơn vị vận hành. Nội dung có thể nằm trong lịch sử Muse.</p><button class="primary create-button" type="submit" ${settings.enabled?'':'disabled'}>Tạo video thương hiệu <span>↗</span></button>${settings.enabled?'':'<p class="inline-warning">Quản trị viên đang tạm dừng nhận yêu cầu.</p>'}</form><aside class="flow-panel"><p class="eyebrow">QUY TRÌNH TỰ ĐỘNG</p><h3>Từ ý tưởng đến<br><em>video hoàn chỉnh.</em></h3><ol><li><span>01</span><div><strong>Phân tích</strong><p>Muse chia nội dung thành các cảnh liên tục.</p></div></li><li><span>02</span><div><strong>Tạo từng cảnh</strong><p>Cùng ảnh tham chiếu, 9:16, ${settings.scene_seconds} giây mỗi cảnh.</p></div></li><li><span>03</span><div><strong>Ghép video</strong><p>Các cảnh được nối thành một file MP4.</p></div></li></ol><div class="flow-foot">Mỗi tài khoản tối đa ${settings.daily_limit} yêu cầu/ngày</div></aside></div>`;
  const duration=section.querySelector('.duration-box');
  duration.innerHTML='<label for="scene-duration">Mỗi đoạn nói</label><select id="scene-duration" aria-label="Thời lượng cố định"><option value="10">10 giây</option></select><small id="total-duration"></small>';
  section.querySelector('#scene-duration').disabled=true;
  section.querySelector('.create-button').disabled=!settings.enabled||!modes.some(mode=>mode.seconds===10);
  section.querySelector('.create-button').innerHTML='Tạo kịch bản <span aria-hidden="true">↗</span>';
  section.querySelector('.step-badge').textContent=`01 - ${String(settings.max_scenes).padStart(2,'0')} ĐOẠN`;
  section.querySelectorAll('#scene-count option').forEach(option=>option.textContent=option.value+' đoạn');
  section.querySelector('#content').placeholder='Ví dụ: Giới thiệu Đại Ngân Farm. Tôi muốn người trong ảnh chia sẻ gần gũi với khán giả về thương hiệu này.';
  document.querySelector('#open-brand .tool-desc').textContent='Một ảnh nhân vật, lời thoại nhiều đoạn liên tiếp.';
  section.querySelector('.module-head p:not(.eyebrow)').textContent='Một nhân vật, một bối cảnh. Xem và sửa lời thoại trước khi tạo video.';
  section.querySelector('.form-header p').textContent='Muse chỉ viết kịch bản ở bước này. Video bắt đầu sau khi bạn duyệt lời thoại.';
  section.querySelector('label[for="scene-count"]').firstChild.textContent='Số đoạn muốn tạo';
  section.querySelector('.flow-panel .eyebrow').textContent='HAI BƯỚC CÓ KIỂM SOÁT';
  const flow=section.querySelectorAll('.flow-panel ol li');
  flow[0].querySelector('strong').textContent='Tạo kịch bản';flow[0].querySelector('p').textContent='Muse viết đủ số đoạn, mỗi đoạn 10 giây.';
  flow[1].querySelector('strong').textContent='Bạn chỉnh lời thoại';flow[1].querySelector('p').textContent='Sửa từng đoạn và duyệt nội dung cuối cùng.';
  flow[2].querySelector('strong').textContent='Tạo và ghép video';flow[2].querySelector('p').textContent='Mỗi clip dùng cùng ảnh gốc; hệ thống ghép theo thứ tự.';
  const limit=document.createElement('p');limit.className='inline-warning';
  limit.textContent='Muse tạo từng clip 10 giây. Ảnh và hướng dẫn giữ nhân vật, giọng nói được dùng lại cho mỗi clip; hiện chưa có khóa khuôn mặt hoặc giọng nói được xác nhận. Hãy xem thành phẩm trước khi sử dụng.';
  section.querySelector('.flow-foot').after(limit);
  const editingPolicy=document.createElement('p');editingPolicy.className='script-editing-policy';
  editingPolicy.textContent='Muse sẽ biên tập bản thô theo số đoạn bạn chọn: phát triển ý ngắn bằng lời dẫn tự nhiên, cô đọng ý dài và giữ thông điệp chính. Muse không tự bịa thông tin về thương hiệu.';
  section.querySelector('.consent').before(editingPolicy);
  const guidance=document.createElement('p');guidance.id='content-guidance';guidance.className='muted';guidance.setAttribute('aria-live','polite');
  section.querySelector('#content').after(guidance);
  const updateGuidance=()=>{
    const content=section.querySelector('#content').value.trim(),scene_count=Number(section.querySelector('#scene-count').value),scene_seconds=Number(section.querySelector('#scene-duration').value)||settings.scene_seconds;
    section.querySelector('#total-duration').textContent=`Tổng ${scene_count*10} giây`;
    guidance.textContent=!content?'Nhập ý tưởng hoặc nội dung thô. Muse chỉ viết kịch bản; bạn sẽ xem và sửa từng đoạn trước khi tạo video.':storyboardInput({content,scene_count,scene_seconds}).kind==='brief'?`Muse sẽ phát triển ý tưởng ngắn này thành ${scene_count} đoạn nói liên tiếp, không tự bịa thông tin thương hiệu.`:`Muse sẽ biên tập toàn bộ nội dung thành ${scene_count} đoạn nói liên tiếp, cùng một nhân vật và bối cảnh.`;
  };
  for(const selector of ['#content','#scene-count'])section.querySelector(selector).addEventListener('input',updateGuidance);
  updateGuidance();
  const memberCode=document.createElement('p');memberCode.className='muted';memberCode.textContent=`Mã thành viên: ${session.user.id}`;
  section.querySelector('.form-header').after(memberCode);
  on('#reference','change',()=>{
    const file=document.querySelector('#reference').files[0];if(previewUrl)URL.revokeObjectURL(previewUrl);
    const image=document.querySelector('#image-preview');
    if(file){previewUrl=URL.createObjectURL(file);image.src=previewUrl;image.hidden=false;document.querySelector('#file-name').textContent=file.name;}
    else {image.hidden=true;document.querySelector('#file-name').textContent='Chọn hoặc kéo ảnh vào đây';}
  });
  on('#create-form','submit',submitBrand);
}

async function fileHash(file){
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
async function submitBrand(event) {
  event.preventDefault();clearMessage();
  const userId=session?.user.id;
  if(!userId)return;
  const submitClient=createClient(supabaseUrl,supabaseKey,{global:{headers:{Authorization:'Bearer '+session.access_token}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const file=document.querySelector('#reference').files[0];
  if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)return message('Chọn ảnh JPG, PNG hoặc WebP dưới 10 MB.','error');
  const content=document.querySelector('#content').value.trim(),sceneCount=Number(document.querySelector('#scene-count').value),seconds=10;
  // The owner explicitly authorized automatic editing of long raw input:
  // retain the main message and condense only secondary/repeated details.
  const allowSummarize=true;
  const button=event.submitter||event.currentTarget.querySelector('[type=submit]');button.disabled=true;button.textContent='Đang gửi yêu cầu kịch bản…';
  try{
    const referenceHash=await fileHash(file);
    if(session?.user.id!==userId)return;
    const fingerprint=await fileHash(new Blob([JSON.stringify(['brand-v3',userId,content,sceneCount,seconds,referenceHash,allowSummarize])]));
    const storageKey='muse-script-submit:'+userId;
    let pending;try{pending=JSON.parse(localStorage.getItem(storageKey));}catch{}
    if(!pending||pending.fingerprint!==fingerprint)pending={id:crypto.randomUUID(),key:crypto.randomUUID(),fingerprint};
    localStorage.setItem(storageKey,JSON.stringify(pending));
    const created=await submitClient.rpc('submit_brand_job_v3',{p_id:pending.id,p_request_key:pending.key,p_content:content,p_scene_count:sceneCount,p_reference_sha256:referenceHash,p_allow_summarize:allowSummarize});
    if(created.error)throw created.error;
    const job=created.data;
    if(job.status==='uploading'){
      const uploaded=await submitClient.storage.from('brand-references').upload(job.reference_path,file,{contentType:file.type,upsert:false});
      if(uploaded.error){const existing=await submitClient.storage.from('brand-references').download(job.reference_path);if(existing.error||await fileHash(existing.data)!==referenceHash)throw uploaded.error;}
      const queued=await submitClient.rpc('queue_brand_job',{p_id:job.id});if(queued.error)throw queued.error;
    }
    localStorage.removeItem(storageKey);
    if(session?.user.id!==userId)return;
    message('Đã nhận yêu cầu tạo kịch bản. Chưa bắt đầu tạo video.','success');
    document.querySelector('#create-form').reset();document.querySelector('#content').dispatchEvent(new Event('input'));document.querySelector('#image-preview').hidden=true;document.querySelector('#file-name').textContent='Chọn hoặc kéo ảnh vào đây';
    await refreshJobs();document.querySelector('#jobs').scrollIntoView({behavior:'smooth'});
  }catch(error){if(session?.user.id===userId)message(error.message||'Không gửi được yêu cầu. Hãy thử lại.','error');}
  finally{if(button.isConnected){button.disabled=!settings?.enabled||!modes.some(mode=>mode.seconds===10);button.textContent='Tạo kịch bản';}}
}

function renderJobs() {
  jobsSignature='';
  jobsVisibleCount=3;jobsTotalCount=0;
  clearInterval(retentionClock);
  document.querySelector('#jobs').innerHTML='<div class="section-head"><div><p class="eyebrow">THƯ VIỆN CỦA TÔI</p><h2>Video của tôi</h2></div><span class="section-note">Mỗi cảnh được cập nhật theo tiến độ</span></div><p class="retention-intro">Video hoàn tất được lưu trong 60 phút. Hãy tải xuống thiết bị trước khi hết hạn.</p><div id="jobs-list" class="jobs-list"><div class="empty">Đang tải video…</div></div><div id="jobs-pagination" class="jobs-pagination" aria-live="polite"></div>';
  retentionClock=setInterval(updateRetentionCountdowns,1000);
  refreshJobs();
}

function formatRemaining(milliseconds) {
  const total=Math.max(0,Math.floor(milliseconds/1000));
  return `${Math.floor(total/60)} phút ${String(total%60).padStart(2,'0')} giây`;
}

function updateRetentionCountdowns() {
  document.querySelectorAll('.retention-timer[data-expiry]').forEach(timer=>{
    const remaining=Date.parse(timer.dataset.expiry)-Date.now();
    timer.textContent=remaining>0?formatRemaining(remaining):'đang chờ máy chủ xác nhận xóa';
    const notice=timer.closest('.retention-state');
    notice?.classList.toggle('retention-active',remaining>10*60*1000);
    notice?.classList.toggle('retention-warning',remaining<=10*60*1000&&remaining>5*60*1000);
    notice?.classList.toggle('retention-urgent',remaining<=5*60*1000);
    if(remaining<=0){
      const card=timer.closest('.job-card');
      card?.querySelectorAll('.view-video,.download-final,.video-slot').forEach(element=>{
        if(element.matches('.video-slot'))element.replaceChildren();
        else {element.disabled=true;element.hidden=true;}
      });
      const jobId=card?.dataset.jobId;
      if(jobId&&!retentionExpiredRefreshes.has(jobId)){retentionExpiredRefreshes.add(jobId);refreshJobs();}
    }
  });
}

function retentionMarkup(job) {
  if(job.status!=='done')return '';
  if(job.retention_status==='expired')return '<div class="expired-label retention-state" role="status">Đã hết hạn – File đã được xóa</div>';
  if(job.retention_status==='deleting')return '<div class="expiry-warning retention-state" role="status">Đã hết thời hạn lưu; hệ thống đang xác nhận xóa file.</div>';
  if(job.retention_status==='delete_failed'&&job.retention_next_attempt_at)return `<div class="expiry-warning retention-state" role="status">Đã quá thời hạn lưu. Hệ thống sẽ thử xóa lại (lần ${Number(job.retention_attempts||0)}/5); chưa xác nhận file đã được xóa.</div>`;
  if(job.retention_status==='delete_failed')return '<div class="expiry-warning retention-state" role="status">Hệ thống chưa xóa được file sau các lần thử lại. File chưa được xác nhận đã xóa; quản trị viên cần kiểm tra.</div>';
  if(job.retention_status==='active'&&job.output_expires_at){
    const remaining=Date.parse(job.output_expires_at)-Date.now();
    return `<div class="expiry-warning retention-state ${remaining<=5*60*1000?'retention-urgent':remaining<=10*60*1000?'retention-warning':'retention-active'}" role="status"><span>Ảnh/video của bạn đã được tạo thành công. File chỉ được lưu trong 60 phút và sẽ tự động xóa. Vui lòng tải về thiết bị để tránh mất dữ liệu.</span><strong class="retention-badge">Thời gian còn lại: <span class="retention-timer" data-expiry="${safe(job.output_expires_at)}">${remaining>0?formatRemaining(remaining):'đang chờ máy chủ xác nhận xóa'}</span></strong></div>`;
  }
  if(job.retention_status&&job.retention_status!=='active')return '<div class="expiry-warning retention-state" role="status">Không xác định được thời hạn lưu file. Tải xuống ngay nếu file còn khả dụng.</div>';
  return '<div class="retention-badge retention-state" role="status">Kết quả được tạo trước khi áp dụng thời hạn lưu tự động.</div>';
}

function mediaStillAvailable(retentionStatus,expiresAt) {
  return !['deleting','expired','delete_failed'].includes(retentionStatus)&&(!expiresAt||Date.parse(expiresAt)>Date.now());
}

function canDownloadFinal(job) {
  return job.status==='done'&&Boolean(job.final_path)&&mediaStillAvailable(job.retention_status,job.output_expires_at);
}

async function downloadStoredVideo({path,id,scene,button,userId,retentionStatus,expiresAt}) {
  button.disabled=true;
  try {
    if(!mediaStillAvailable(retentionStatus,expiresAt))throw Error('File đã hết hạn hoặc đang được xóa.');
    const actor=createClient(supabaseUrl,supabaseKey,{global:{headers:{Authorization:'Bearer '+session.access_token}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const file=await actor.storage.from('brand-videos').download(path);if(file.error)throw file.error;
    if(session?.user.id!==userId)return;
    if(!mediaStillAvailable(retentionStatus,expiresAt))throw Error('File đã hết hạn trong lúc tải xuống.');
    const url=URL.createObjectURL(file.data),link=document.createElement('a');
    link.href=url;link.download=`muse-${id}${scene?`-doan-${scene}`:''}.mp4`;document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  } catch(error) { if(session?.user.id===userId)message('Không tải được video: '+error.message,'error'); }
  finally { if(button.isConnected)button.disabled=false; }
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
  editor.innerHTML=`<h4>Kịch bản để bạn chỉnh sửa</h4><p class="muted">Muse đã viết lời thoại. Video chỉ bắt đầu sau khi bạn bấm “Tạo video”.</p><label class="script-count">Số đoạn<select class="script-scene-count">${Array.from({length:settings.max_scenes},(_,i)=>`<option value="${i+1}" ${job.scene_count===i+1?'selected':''}>${i+1} đoạn</option>`).join('')}</select></label><p class="script-total">${job.scene_count} đoạn × 10 giây = ${job.scene_count*10} giây</p>${plan.map(scene=>`<label class="script-line">Đoạn ${scene.index} · 10 giây<textarea class="script-dialogue" data-index="${scene.index}" rows="3" maxlength="600">${safe(scene.dialogue)}</textarea><small>Giọng miền Nam tự nhiên, nói vừa 10 giây và có nhịp nghỉ.</small></label>`).join('')}<p class="script-note" role="status">Lời thoại đã lưu. Bạn có thể sửa trước khi tạo video.</p><div class="script-actions"><button class="outline save-script" type="button">Lưu kịch bản</button><button class="outline replan-script" type="button" hidden>Cập nhật kịch bản</button><button class="primary approve-script" type="button">Tạo video</button></div>`;
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
  const explain=error=>{if(current()){note.textContent=error.message||'Không lưu được kịch bản.';message(note.textContent,'error');}};
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
    try{await operation.catch(()=>{});if(!current())return;const result=await actor().rpc('replan_brand_script_v3',{p_id:job.id,p_revision:Number(editor.dataset.revision),p_scene_count:Number(count.value)});if(result.error)throw result.error;editor.dataset.dirty='false';editor.dataset.busy='false';await refreshJobs({force:true});message('Đã yêu cầu Muse viết lại kịch bản theo số đoạn mới. Chưa tạo video.','success');}
    catch(error){explain(error);if(current())replanButton.disabled=false;}
    finally{if(current())editor.dataset.busy='false';}
  });
}

async function refreshJobs({force=false}={}) {
  if(!session||!document.querySelector('#jobs-list'))return;
  if(!force&&[...document.querySelectorAll('.script-editor')].some(editor=>editor.contains(document.activeElement)||editor.dataset.dirty==='true'||editor.dataset.busy==='true'))return;
  const userId=session.user.id,version=++jobsRefreshVersion;
  const result=await supabase.from('brand_jobs').select('id,user_id,content,scene_count,scene_seconds,status,current_scene,reference_path,reference_sha256,final_path,output_expires_at,retention_status,retention_attempts,retention_next_attempt_at,error,error_code,retryable,attempt,max_attempts,schema_version,workflow_phase,script_revision,allow_summarize,plan,created_at,brand_scenes(scene_index,prompt,dialogue,action,planned_seconds,status,output_path,error,error_code,generation)',{count:'exact'}).eq('user_id',userId).order('created_at',{ascending:false}).order('id',{ascending:false}).range(0,jobsVisibleCount-1);
  const list=document.querySelector('#jobs-list');if(!list||session?.user.id!==userId||version!==jobsRefreshVersion)return;
  if(!force&&[...list.querySelectorAll('.script-editor')].some(editor=>editor.contains(document.activeElement)||editor.dataset.dirty==='true'||editor.dataset.busy==='true'))return;
  if(result.error){list.textContent='Không tải được lịch sử: '+result.error.message;updateJobsPagination();return;}
  jobsTotalCount=result.count??result.data.length;updateJobsPagination();
  if(sceneRetryAvailable===null&&result.data.some(job=>job.status==='error'&&job.schema_version===3&&job.brand_scenes?.some(scene=>['MUSE_OUTPUT_REJECTED','SCENE_MEDIA_INVALID','CUT_OFF_SPEECH','SPEECH_TOO_SHORT','SPEECH_TIMING','SPEECH_MISMATCH','UNEXPECTED_SPEECH'].includes(scene.error_code)))){
    const probe=await supabase.rpc('retry_brand_scene_v3',{p_id:'00000000-0000-0000-0000-000000000000',p_scene:0});
    sceneRetryAvailable=probe.error?.message==='Không tìm thấy yêu cầu';
  }
  if(session?.user.id!==userId||version!==jobsRefreshVersion)return;
  const signature=JSON.stringify([sceneRetryAvailable,jobsTotalCount,result.data]);
  if(signature===jobsSignature)return;
  jobsSignature=signature;
  if(!result.data.length){list.innerHTML='<div class="empty"><strong>Chưa có video nào</strong></div>';return;}
  // Other jobs can advance while a member watches or downloads a finished MP4.
  // Keep that player and its event listeners across the list refresh.
  const openMedia=new Map([...list.querySelectorAll('.video-slot')].filter(slot=>{
    if(!slot.querySelector('video'))return false;
    const job=result.data.find(item=>slot.id===`video-${item.id}`||slot.id.startsWith(`video-${item.id}-scene-`));
    return job&&job.retention_status!=='deleting'&&job.retention_status!=='expired'&&job.retention_status!=='delete_failed'&&(!job.output_expires_at||Date.parse(job.output_expires_at)>Date.now());
  }).map(slot=>[slot.id,slot]));
  const status={uploading:'Đang chờ ảnh',queued:'Đang chờ',script_queued:'Chờ tạo kịch bản',planning:'Đang viết kịch bản',script_ready:'Chờ bạn duyệt',video_queued:'Chờ tạo video',generating:'Đang tạo video',joining:'Đang ghép video',done:'Hoàn tất',error:'Lỗi',needs_review:'Lỗi',reviewed:'Lỗi'};
  list.innerHTML=result.data.map(job=>{
    const scriptNeedsRetry=job.status==='error'&&job.schema_version===3&&job.workflow_phase==='script'&&!job.plan?.length;
    const displayError=job.error_code==='CONTENT_TOO_LONG'?'Muse chưa cô đọng được bản thô ở lượt trước. Hãy tạo lại kịch bản; Muse sẽ tự giữ ý chính và lược chi tiết phụ.':job.error;
    const finalActions=canDownloadFinal(job)?`<button class="outline view-video" data-path="${safe(job.final_path)}" data-id="${safe(job.id)}" data-retention="${safe(job.retention_status||'legacy')}" data-expiry="${safe(job.output_expires_at||'')}">Xem video</button><button class="primary download-final" data-path="${safe(job.final_path)}" data-id="${safe(job.id)}" data-retention="${safe(job.retention_status||'legacy')}" data-expiry="${safe(job.output_expires_at||'')}">Tải xuống</button>`:'';
    const otherAction=job.status==='uploading'?`<label class="outline">Chọn lại ảnh<input class="resume-file" type="file" accept="image/png,image/jpeg,image/webp" data-id="${safe(job.id)}"></label>`:job.status==='error'&&job.retryable&&job.attempt<job.max_attempts?`<button class="outline retry-job" data-id="${safe(job.id)}">Thử lại</button>`:'';
    return `<article class="job-card" data-job-id="${safe(job.id)}"><div class="job-main"><div class="job-top"><span>${shortDate(job.created_at)}</span><span class="status status-${safe(job.status)}">${safe(scriptNeedsRetry?'Cần tạo lại kịch bản':status[job.status]||job.status)}</span></div><div class="job-heading"><img class="job-thumbnail" alt="Ảnh tham chiếu" hidden><h3>${safe(job.content.slice(0,110))}</h3></div><p>${job.scene_count} ${job.schema_version===3?'đoạn':'cảnh'} · ${job.scene_seconds} giây/${job.schema_version===3?'đoạn':'cảnh'} · tổng ${job.scene_count*job.scene_seconds} giây</p><small>Mã yêu cầu: ${safe(job.id)}</small>${displayError?`<p class="job-error">${safe(displayError)}</p>`:''}${retentionMarkup(job)}${scriptNeedsRetry?'<p class="inline-warning">Chưa có kịch bản nên chưa thể tạo video. Sửa số đoạn nếu cần, rồi gửi lại bước “Tạo kịch bản”. Muse sẽ tự xử lý độ dài của bản thô.</p>':`<div class="scene-track">${Array.from({length:job.scene_count},(_,i)=>{const scene=job.brand_scenes?.find(x=>x.scene_index===i+1);return `<span class="scene-pill ${safe(scene?.status||'waiting')}">${String(i+1).padStart(2,'0')}</span>`;}).join('')}</div>`}${job.brand_scenes?.length?`<details><summary>Lời thoại từng đoạn</summary>${job.brand_scenes.sort((a,b)=>a.scene_index-b.scene_index).map(scene=>`<p><strong>Đoạn ${scene.scene_index} · ${scene.planned_seconds||job.scene_seconds} giây</strong><br>Lời thoại: ${safe(scene.dialogue||'Không có')}</p>`).join('')}</details>`:''}</div><div class="job-action">${finalActions}${otherAction}</div><div class="video-slot" id="video-${safe(job.id)}"></div></article>`;
  }).join('');
  result.data.forEach(async(job,index)=>{
    if(!job.reference_path)return;
    const thumbnail=list.children[index]?.querySelector('.job-thumbnail');if(!thumbnail)return;
    const ttl=job.output_expires_at?Math.max(1,Math.floor((Date.parse(job.output_expires_at)-Date.now())/1000)):3600;
    if(ttl<=0||!mediaStillAvailable(job.retention_status,job.output_expires_at))return;
    const {data,error}=await supabase.storage.from('brand-references').createSignedUrl(job.reference_path,Math.min(3600,ttl));
    if(error||!thumbnail.isConnected||!mediaStillAvailable(job.retention_status,job.output_expires_at))return;
    thumbnail.src=data.signedUrl;thumbnail.hidden=false;
  });
  result.data.forEach((job,i)=>{
    const track=list.children[i]?.querySelector('.scene-track');if(!track)return;
    const labels={waiting:'Chờ xử lý',generating:'Đang tạo',done:'Hoàn thành',error:'Thất bại',needs_review:'Cần kiểm tra'};
    track.classList.add('scene-progress');
    track.innerHTML=Array.from({length:job.scene_count},(_,index)=>{
      const scene=job.brand_scenes?.find(item=>item.scene_index===index+1),state=scene?.status||'waiting';
      const slotId=`video-${job.id}-scene-${index+1}`;
      const canResume=state==='error'&&job.status==='error'&&job.retryable&&job.attempt<job.max_attempts;
      const canRestart=sceneRetryAvailable&&state==='error'&&job.status==='error'&&job.schema_version===3&&!canResume&&['MUSE_OUTPUT_REJECTED','SCENE_MEDIA_INVALID','CUT_OFF_SPEECH','SPEECH_TOO_SHORT','SPEECH_TIMING','SPEECH_MISMATCH','UNEXPECTED_SPEECH'].includes(scene?.error_code);
      return `<div class="scene-row"><span class="scene-pill ${safe(state)}">${String(index+1).padStart(2,'0')}</span><span>Đoạn ${index+1}/${job.scene_count}: <strong>${safe(labels[state]||state)}</strong>${state==='generating'?` · lần ${Number(scene?.generation||0)%3+1}/3`:''}${scene?.error&&state==='error'?`<small class="job-error">${safe(scene.error)}</small>`:''}</span>${state==='done'&&scene.output_path&&mediaStillAvailable(job.retention_status,job.output_expires_at)?`<button class="outline view-video view-scene" type="button" data-path="${safe(scene.output_path)}" data-id="${safe(job.id)}" data-scene="${index+1}" data-slot="${safe(slotId)}" data-retention="${safe(job.retention_status||'legacy')}" data-expiry="${safe(job.output_expires_at||'')}">Xem đoạn</button>`:canResume?`<button class="outline retry-job" type="button" data-id="${safe(job.id)}">Tiếp tục từ đoạn ${index+1}</button>`:canRestart?`<button class="outline retry-scene" type="button" data-id="${safe(job.id)}" data-scene="${index+1}">Tạo lại đoạn ${index+1}</button>`:''}<div class="video-slot" id="${safe(slotId)}"></div></div>`;
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
        const image=await actor.storage.from('brand-references').download(job.reference_path);if(image.error)throw image.error;
        if(await fileHash(image.data)!==job.reference_sha256)throw Error('Ảnh đã lưu không khớp ảnh ban đầu.');
        if(session?.user.id!==userId||!edit.isConnected)return;
        const content=document.querySelector('#content'),reference=document.querySelector('#reference');if(!content||!reference)return;
        content.value=job.content;
        for(const [selector,value] of [['#scene-count',job.scene_count],['#scene-duration',job.scene_seconds]]){
          const select=document.querySelector(selector);if([...select.options].some(option=>option.value===String(value)))select.value=String(value);
        }
        const files=new DataTransfer();files.items.add(new File([image.data],'anh-tham-chieu',{type:image.data.type}));reference.files=files.files;
        reference.dispatchEvent(new Event('change'));content.dispatchEvent(new Event('input'));
        document.querySelector('#brand').scrollIntoView({behavior:'smooth'});
        message('Đã điền lại ảnh và nội dung. Hãy chọn số đoạn phù hợp, rồi bấm “Tạo kịch bản”. Muse sẽ tự cô đọng ý dài và phát triển ý ngắn. Chỉ khi kịch bản sẵn sàng, nút “Tạo video” mới xuất hiện.','info');
      }catch(error){if(session?.user.id===userId)message('Không tải lại được ảnh: '+error.message,'error');}
      finally{if(edit.isConnected)edit.disabled=false;}
    });
  }
  list.querySelectorAll('.resume-file').forEach(input=>input.addEventListener('change',async()=>{
    const file=input.files[0],job=result.data.find(item=>item.id===input.dataset.id);if(!file||!job)return;
    input.disabled=true;
    try{
      if(await fileHash(file)!==job.reference_sha256)throw Error('Ảnh không khớp ảnh đã chọn ban đầu.');
      const uploaded=await supabase.storage.from('brand-references').upload(job.reference_path,file,{contentType:file.type,upsert:false});
      if(uploaded.error){const old=await supabase.storage.from('brand-references').download(job.reference_path);if(old.error||await fileHash(old.data)!==job.reference_sha256)throw uploaded.error;}
      const queued=await supabase.rpc('queue_brand_job',{p_id:job.id});if(queued.error)throw queued.error;
      message('Đã đưa yêu cầu vào hàng chờ.','success');await refreshJobs();
    }catch(error){message(error.message,'error');input.disabled=false;}
  }));
  list.querySelectorAll('.retry-job').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;const result=await supabase.rpc('retry_brand_job',{p_id:button.dataset.id});if(result.error)message(result.error.message,'error');await refreshJobs();button.disabled=false;}));
  list.querySelectorAll('.retry-scene').forEach(button=>button.addEventListener('click',async()=>{
    button.disabled=true;
    const result=await supabase.rpc('retry_brand_scene_v3',{p_id:button.dataset.id,p_scene:Number(button.dataset.scene)});
    if(result.error)message(result.error.message,'error');else message(`Đã xếp lại đoạn ${button.dataset.scene}; các đoạn hoàn tất được giữ nguyên.`,'success');
    await refreshJobs({force:true});if(button.isConnected)button.disabled=false;
  }));
  list.querySelectorAll('.download-final').forEach(button=>button.addEventListener('click',()=>downloadStoredVideo({path:button.dataset.path,id:button.dataset.id,button,userId,retentionStatus:button.dataset.retention,expiresAt:button.dataset.expiry||null})));
  list.querySelectorAll('.view-video').forEach(button=>button.addEventListener('click',async()=>{
    if(!mediaStillAvailable(button.dataset.retention,button.dataset.expiry||null)){message('File đã hết hạn hoặc đang được xóa.','error');refreshJobs({force:true});return;}
    button.disabled=true;
    const ttl=button.dataset.expiry?Math.max(1,Math.floor((Date.parse(button.dataset.expiry)-Date.now())/1000)):3600;
    const {data,error}=await supabase.storage.from('brand-videos').createSignedUrl(button.dataset.path,Math.min(3600,ttl));
    if(session?.user.id!==userId||!button.isConnected)return;
    if(error){message(error.message,'error');button.disabled=false;return;}
    if(!mediaStillAvailable(button.dataset.retention,button.dataset.expiry||null)){message('File đã hết hạn trong lúc mở.','error');refreshJobs({force:true});return;}
    const slot=document.getElementById(button.dataset.slot||`video-${button.dataset.id}`);
    if(!slot){button.disabled=false;return;}
    slot.innerHTML=`<video controls playsinline src="${safe(data.signedUrl)}"></video><button class="outline download-video" type="button">Tải MP4</button>`;button.hidden=true;
    slot.querySelector('.download-video').addEventListener('click',event=>downloadStoredVideo({path:button.dataset.path,id:button.dataset.id,scene:button.dataset.scene,button:event.currentTarget,userId,retentionStatus:button.dataset.retention,expiresAt:button.dataset.expiry||null}));
  }));
}

function renderAdmin() {
  document.querySelector('#admin').innerHTML=`<div class="section-head"><div><p class="eyebrow">DÀNH CHO QUẢN TRỊ</p><h2>Cài đặt & thành viên</h2></div><span class="section-note">Chỉ quản trị viên có quyền thay đổi</span></div><div class="admin-grid"><form id="settings-form" class="admin-card"><h3>Cài đặt tạo video</h3><label class="toggle"><input id="enabled" type="checkbox" ${settings.enabled?'checked':''}><span>Nhận yêu cầu mới</span></label><label>Số cảnh tối đa<select id="max-scenes">${Array.from({length:8},(_,i)=>`<option value="${i+1}" ${settings.max_scenes===i+1?'selected':''}>${i+1} cảnh</option>`).join('')}</select></label><label>Lượt mỗi thành viên/ngày<input id="daily-limit" type="number" min="1" max="30" value="${settings.daily_limit}"></label><label>Thời lượng mỗi cảnh<select id="scene-seconds"><option value="10" ${settings.scene_seconds===10?'selected':''}>10 giây</option><option value="5" ${settings.scene_seconds===5?'selected':''}>5 giây</option></select></label><button class="primary" type="submit">Lưu cài đặt</button><p class="admin-note">Worker trên máy phải đăng nhập Muse và chạy trước khi mở nhận yêu cầu.</p></form><div class="admin-card"><h3>Thành viên</h3><div id="member-list" class="mini-list">Đang tải…</div></div><div class="admin-card full-width"><h3>Tác vụ cần kiểm tra</h3><div id="review-list" class="mini-list">Đang tải…</div></div></div>`;
  document.querySelector('#max-scenes').closest('label').firstChild.textContent='Số đoạn tối đa';
  document.querySelectorAll('#max-scenes option').forEach(option=>option.textContent=option.value+' đoạn');
  document.querySelector('#scene-seconds').closest('label').textContent='Mục Thương hiệu sử dụng cố định đoạn 10 giây đã kiểm chứng.';
  on('#settings-form','submit',async event=>{
    event.preventDefault();const values={enabled:document.querySelector('#enabled').checked,max_scenes:Number(document.querySelector('#max-scenes').value),daily_limit:Number(document.querySelector('#daily-limit').value),updated_at:new Date().toISOString()};
    const {error}=await supabase.from('app_settings').update(values).eq('id',true);if(error)return message(error.message,'error');settings={...settings,...values};message('Đã lưu cài đặt.','success');renderModule();
  });
  refreshAdmin();
}

async function refreshAdmin() {
  if(profile?.role!=='admin'||!document.querySelector('#member-list'))return;
  const userId=session.user.id;
  const [members,jobs]=await Promise.all([
    supabase.from('profiles').select('id,email,role,approved,created_at').order('created_at',{ascending:false}),
    supabase.from('brand_jobs').select('id,content,user_id,error,error_code,retryable,attempt,max_attempts,schema_version,created_at').in('status',['needs_review','error']).order('created_at',{ascending:false})
  ]);
  if(session?.user.id!==userId||profile?.role!=='admin'||!document.querySelector('#member-list'))return;
  const memberList=document.querySelector('#member-list');
  memberList.innerHTML=members.error?`<p>${safe(members.error.message)}</p>`:members.data.filter(user=>user.role==='member').map(user=>`<div class="mini-row"><div><strong>${safe(user.email)}</strong><small>${user.approved?'Đang hoạt động':'Chờ duyệt'}</small></div><button class="outline approve-user" data-id="${safe(user.id)}" data-next="${!user.approved}">${user.approved?'Tạm khóa':'Duyệt'}</button></div>`).join('')||'<p>Chưa có thành viên.</p>';
  memberList.querySelectorAll('.approve-user').forEach(button=>button.addEventListener('click',async()=>{const {error}=await supabase.from('profiles').update({approved:button.dataset.next==='true'}).eq('id',button.dataset.id);if(error)return message(error.message,'error');await refreshAdmin();}));
  const reviewList=document.querySelector('#review-list');
  reviewList.innerHTML=jobs.error?`<p>${safe(jobs.error.message)}</p>`:jobs.data.map(job=>`<div class="mini-row"><div><strong>${safe(job.content.slice(0,120))}</strong><small>${shortDate(job.created_at)} · ${safe(job.error||'Cần kiểm tra trên Muse')}</small></div>${job.schema_version===2?(job.retryable&&job.attempt<job.max_attempts?`<button class="outline retry-admin-job" data-id="${safe(job.id)}">Thử lại</button>`:'<small>Cần kiểm tra nguyên nhân trước khi tạo yêu cầu mới.</small>'):`<button class="outline review-job" data-id="${safe(job.id)}">Đã kiểm tra</button>`}</div>`).join('')||'<p>Không có tác vụ cần kiểm tra.</p>';
  reviewList.querySelectorAll('.retry-admin-job').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;const {error}=await supabase.rpc('retry_brand_job',{p_id:button.dataset.id});if(error)message(error.message,'error');await refreshAdmin();await refreshJobs();}));
  reviewList.querySelectorAll('.review-job').forEach(button=>button.addEventListener('click',async()=>{if(!window.confirm('Bạn đã xem kết quả trong Muse và xác nhận không còn tác vụ đang chạy?'))return;const {error}=await supabase.rpc('review_legacy_brand_job',{p_id:button.dataset.id});if(error)return message(error.message,'error');await refreshAdmin();await refreshJobs();}));
}

async function loadApp() {
  const epoch=++appEpoch;
  showLoading();
  const result=await supabase.auth.getSession();if(epoch!==appEpoch)return;session=result.data.session;
  if(!session){authView();return;}
  try {if(!await loadProfile(session.user.id)||epoch!==appEpoch)return;shell();clearInterval(poller);poller=setInterval(()=>{refreshJobs();if(profile?.role==='admin')refreshAdmin();},7000);}
  catch(error){if(epoch!==appEpoch)return;root.innerHTML=`<main class="fatal"><h1>Không mở được không gian làm việc</h1><p>${safe(error.message)}</p><button class="primary" id="retry-app">Thử lại</button></main>`;on('#retry-app','click',loadApp);}
}

if(!supabase)root.innerHTML='<main class="fatal"><h1>Chưa cấu hình web</h1><p>Cần đặt VITE_SUPABASE_PUBLISHABLE_KEY khi triển khai.</p></main>';
else {supabase.auth.onAuthStateChange((_event,newSession)=>{if(newSession?.user?.id!==session?.user?.id){appEpoch++;session=newSession;profile=null;settings=null;modes=[];clearInterval(poller);showLoading();setTimeout(loadApp,0);}else session=newSession;});loadApp();}
