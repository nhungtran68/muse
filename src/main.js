import {createClient} from '@supabase/supabase-js';
import {adminEmail, supabaseKey, supabaseUrl} from './config.js';
import './styles.css';

const root = document.querySelector('#app');
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const shortDate = value => new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
const labels = {uploading:'Đang tải ảnh',queued:'Đang xếp hàng',planning:'AI chia cảnh',generating:'Đang tạo cảnh',joining:'Đang ghép',done:'Hoàn tất',needs_review:'Cần kiểm tra',reviewed:'Đã kiểm tra'};
let session = null, profile = null, settings = null, poller = null, previewUrl = null;

function message(text, type='info') {
  const box = document.querySelector('#notice');
  if (box) {box.textContent=text; box.className='notice '+type; box.hidden=false;}
}
function clearMessage() { const box=document.querySelector('#notice'); if(box) box.hidden=true; }
function on(selector,event,handler) { document.querySelector(selector)?.addEventListener(event,handler); }
function showLoading() { root.innerHTML='<main class="loading"><span class="spinner"></span><p>Đang mở không gian sáng tạo…</p></main>'; }

function authView(mode='login') {
  clearInterval(poller);
  root.innerHTML=`<div class="auth-layout"><div class="auth-art"><div class="brandmark">M<span>•</span></div><p class="eyebrow">MUSE STUDIO</p><h1>Từ ý tưởng<br>đến thước phim.</h1><p>Một không gian để thành viên tạo video theo từng cảnh, theo dõi tiến độ và lấy bản hoàn chỉnh.</p><div class="art-lines"><i></i><i></i><i></i></div></div><main class="auth-panel"><div class="auth-box"><p class="eyebrow">TÀI KHOẢN</p><h2>${mode==='signup'?'Tạo tài khoản':'Chào mừng trở lại'}</h2><p class="muted">${mode==='signup'?'Đăng ký bằng email. Quản trị viên sẽ duyệt trước khi bạn tạo video.':'Đăng nhập để tiếp tục sáng tạo.'}</p><form id="auth-form"><label>Email<input id="auth-email" type="email" autocomplete="email" required></label><label>Mật khẩu<input id="auth-password" type="password" autocomplete="${mode==='signup'?'new-password':'current-password'}" minlength="12" required></label><button class="primary full" type="submit">${mode==='signup'?'Đăng ký':'Đăng nhập'} <span aria-hidden="true">↗</span></button></form><div id="notice" class="notice" hidden role="status"></div><button id="switch-auth" class="text-button">${mode==='signup'?'Đã có tài khoản? Đăng nhập':'Chưa có tài khoản? Đăng ký'}</button></div></main></div>`;
  on('#switch-auth','click',()=>authView(mode==='signup'?'login':'signup'));
  on('#auth-form','submit',async event=>{
    event.preventDefault(); clearMessage();
    const email=document.querySelector('#auth-email').value.trim(),password=document.querySelector('#auth-password').value;
    const button=event.submitter;button.disabled=true;button.textContent='Đang xử lý…';
    const result=mode==='signup'?await supabase.auth.signUp({email,password}):await supabase.auth.signInWithPassword({email,password});
    if(result.error){message(result.error.message,'error');button.disabled=false;button.textContent=mode==='signup'?'Đăng ký':'Đăng nhập';return;}
    if(mode==='signup'&&!result.data.session){message('Đã gửi email xác nhận. Hãy xác nhận email rồi đăng nhập.','success');button.disabled=false;button.textContent='Đăng ký';return;}
    await loadApp();
  });
}

async function loadProfile() {
  const {data,error}=await supabase.from('profiles').select('*').eq('id',session.user.id).maybeSingle();
  if(error) throw error;
  profile=data;
  const settingResult=await supabase.from('app_settings').select('*').eq('id',true).single();
  if(settingResult.error) throw settingResult.error;
  settings=settingResult.data;
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
  on('#reference','change',()=>{
    const file=document.querySelector('#reference').files[0];if(previewUrl)URL.revokeObjectURL(previewUrl);
    const image=document.querySelector('#image-preview');
    if(file){previewUrl=URL.createObjectURL(file);image.src=previewUrl;image.hidden=false;document.querySelector('#file-name').textContent=file.name;}
    else {image.hidden=true;document.querySelector('#file-name').textContent='Chọn hoặc kéo ảnh vào đây';}
  });
  on('#create-form','submit',submitBrand);
}

async function submitBrand(event) {
  event.preventDefault();clearMessage();
  const file=document.querySelector('#reference').files[0];
  if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)return message('Chọn ảnh JPG, PNG hoặc WebP dưới 10 MB.','error');
  const content=document.querySelector('#content').value.trim();
  const sceneCount=Number(document.querySelector('#scene-count').value);
  const id=crypto.randomUUID(),path=`${session.user.id}/${id}/reference`;
  const button=event.submitter;button.disabled=true;button.textContent='Đang tải ảnh…';
  try {
    const first=await supabase.rpc('submit_brand_job',{p_id:id,p_content:content,p_scene_count:sceneCount,p_reference_path:path});
    if(first.error)throw first.error;
    const uploaded=await supabase.storage.from('brand-references').upload(path,file,{contentType:file.type,upsert:false});
    if(uploaded.error){await supabase.rpc('cancel_brand_upload',{p_id:id});throw uploaded.error;}
    const queued=await supabase.rpc('queue_brand_job',{p_id:id});
    if(queued.error){await supabase.storage.from('brand-references').remove([path]);await supabase.rpc('cancel_brand_upload',{p_id:id});throw queued.error;}
    message('Đã nhận yêu cầu. Các cảnh sẽ hiển thị trong danh sách bên dưới.','success');
    document.querySelector('#create-form').reset();document.querySelector('#image-preview').hidden=true;document.querySelector('#file-name').textContent='Chọn hoặc kéo ảnh vào đây';
    await refreshJobs();document.querySelector('#jobs').scrollIntoView({behavior:'smooth'});
  } catch(error) {message(error.message||'Không tạo được tác vụ. Hãy thử lại.','error');}
  finally {button.disabled=false;button.innerHTML='Tạo video thương hiệu <span>↗</span>';}
}

function renderJobs() {
  document.querySelector('#jobs').innerHTML='<div class="section-head"><div><p class="eyebrow">THƯ VIỆN CỦA TÔI</p><h2>Video của tôi</h2></div><span class="section-note">Mỗi cảnh được cập nhật theo tiến độ</span></div><div id="jobs-list" class="jobs-list"><div class="empty">Đang tải video…</div></div>';
  refreshJobs();
}

async function refreshJobs() {
  if(!session||!document.querySelector('#jobs-list'))return;
  const result=await supabase.from('brand_jobs').select('id,content,scene_count,scene_seconds,status,current_scene,plan,final_path,error,created_at,brand_scenes(scene_index,prompt,status,output_path)').order('created_at',{ascending:false}).limit(30);
  const list=document.querySelector('#jobs-list'); if(!list)return;
  if(result.error){list.innerHTML=`<div class="empty error">${safe(result.error.message)} <button id="retry-jobs" class="text-button">Thử lại</button></div>`;on('#retry-jobs','click',refreshJobs);return;}
  if(!result.data.length){list.innerHTML='<div class="empty"><span>◌</span><strong>Chưa có video nào</strong><p>Chọn ảnh và nhập ý tưởng để bắt đầu video đầu tiên.</p></div>';return;}
  list.innerHTML=result.data.map(job=>`<article class="job-card"><div class="job-main"><div class="job-top"><span class="job-date">${shortDate(job.created_at)}</span><span class="status status-${safe(job.status)}">${safe(labels[job.status]||job.status)}</span></div><h3>${safe(job.content.slice(0,110))}${job.content.length>110?'…':''}</h3><p>${job.scene_count} cảnh · ${job.scene_seconds} giây/cảnh</p>${job.error?`<p class="job-error">${safe(job.error)}</p>`:''}<div class="scene-track">${Array.from({length:job.scene_count},(_,i)=>{const scene=job.brand_scenes?.find(x=>x.scene_index===i+1);const state=scene?.status||'waiting';return `<span class="scene-pill ${safe(state)}" title="${safe(scene?.prompt||'Cảnh '+(i+1))}">${String(i+1).padStart(2,'0')}</span>`;}).join('')}</div></div><div class="job-action">${job.status==='done'&&job.final_path?`<button class="outline view-video" data-path="${safe(job.final_path)}" data-id="${safe(job.id)}">Xem MP4 ↗</button>`:`<span>${job.status==='needs_review'?'Quản trị viên sẽ kiểm tra':job.status==='reviewed'?'Đã được kiểm tra':'Đang xử lý'}</span>`}</div><div class="video-slot" id="video-${safe(job.id)}"></div></article>`).join('');
  document.querySelectorAll('.view-video').forEach(button=>button.addEventListener('click',async()=>{
    button.disabled=true;button.textContent='Đang mở…';
    const {data,error}=await supabase.storage.from('brand-videos').createSignedUrl(button.dataset.path,3600);
    if(error){message(error.message,'error');button.disabled=false;button.textContent='Xem MP4 ↗';return;}
    document.querySelector(`#video-${CSS.escape(button.dataset.id)}`).innerHTML=`<video controls playsinline src="${safe(data.signedUrl)}"></video><a class="download-link" href="${safe(data.signedUrl)}" download="muse-${safe(button.dataset.id)}.mp4">Tải MP4 ↓</a>`;
    button.hidden=true;
  }));
}

function renderAdmin() {
  document.querySelector('#admin').innerHTML=`<div class="section-head"><div><p class="eyebrow">DÀNH CHO QUẢN TRỊ</p><h2>Cài đặt & thành viên</h2></div><span class="section-note">Chỉ quản trị viên có quyền thay đổi</span></div><div class="admin-grid"><form id="settings-form" class="admin-card"><h3>Cài đặt tạo video</h3><label class="toggle"><input id="enabled" type="checkbox" ${settings.enabled?'checked':''}><span>Nhận yêu cầu mới</span></label><label>Số cảnh tối đa<select id="max-scenes">${Array.from({length:8},(_,i)=>`<option value="${i+1}" ${settings.max_scenes===i+1?'selected':''}>${i+1} cảnh</option>`).join('')}</select></label><label>Lượt mỗi thành viên/ngày<input id="daily-limit" type="number" min="1" max="30" value="${settings.daily_limit}"></label><label>Thời lượng mỗi cảnh<select id="scene-seconds"><option value="10" ${settings.scene_seconds===10?'selected':''}>10 giây</option><option value="5" ${settings.scene_seconds===5?'selected':''}>5 giây</option></select></label><button class="primary" type="submit">Lưu cài đặt</button><p class="admin-note">Worker trên máy phải đăng nhập Muse và chạy trước khi mở nhận yêu cầu.</p></form><div class="admin-card"><h3>Thành viên</h3><div id="member-list" class="mini-list">Đang tải…</div></div><div class="admin-card full-width"><h3>Tác vụ cần kiểm tra</h3><div id="review-list" class="mini-list">Đang tải…</div></div></div>`;
  on('#settings-form','submit',async event=>{
    event.preventDefault();const values={enabled:document.querySelector('#enabled').checked,max_scenes:Number(document.querySelector('#max-scenes').value),daily_limit:Number(document.querySelector('#daily-limit').value),scene_seconds:Number(document.querySelector('#scene-seconds').value),updated_at:new Date().toISOString()};
    const {error}=await supabase.from('app_settings').update(values).eq('id',true);if(error)return message(error.message,'error');settings={...settings,...values};message('Đã lưu cài đặt.','success');renderModule();
  });
  refreshAdmin();
}

async function refreshAdmin() {
  if(profile?.role!=='admin'||!document.querySelector('#member-list'))return;
  const [members,jobs]=await Promise.all([
    supabase.from('profiles').select('id,email,role,approved,created_at').order('created_at',{ascending:false}),
    supabase.from('brand_jobs').select('id,content,user_id,error,created_at').eq('status','needs_review').order('created_at',{ascending:false})
  ]);
  const memberList=document.querySelector('#member-list');
  memberList.innerHTML=members.error?`<p>${safe(members.error.message)}</p>`:members.data.filter(user=>user.role==='member').map(user=>`<div class="mini-row"><div><strong>${safe(user.email)}</strong><small>${user.approved?'Đang hoạt động':'Chờ duyệt'}</small></div><button class="outline approve-user" data-id="${safe(user.id)}" data-next="${!user.approved}">${user.approved?'Tạm khóa':'Duyệt'}</button></div>`).join('')||'<p>Chưa có thành viên.</p>';
  memberList.querySelectorAll('.approve-user').forEach(button=>button.addEventListener('click',async()=>{const {error}=await supabase.from('profiles').update({approved:button.dataset.next==='true'}).eq('id',button.dataset.id);if(error)return message(error.message,'error');await refreshAdmin();}));
  const reviewList=document.querySelector('#review-list');
  reviewList.innerHTML=jobs.error?`<p>${safe(jobs.error.message)}</p>`:jobs.data.map(job=>`<div class="mini-row"><div><strong>${safe(job.content.slice(0,120))}</strong><small>${shortDate(job.created_at)} · ${safe(job.error||'Cần kiểm tra trên Muse')}</small></div><button class="outline review-job" data-id="${safe(job.id)}">Đã kiểm tra</button></div>`).join('')||'<p>Không có tác vụ cần kiểm tra.</p>';
  reviewList.querySelectorAll('.review-job').forEach(button=>button.addEventListener('click',async()=>{if(!window.confirm('Bạn đã xem kết quả trong Muse và xác nhận không còn tác vụ đang chạy?'))return;const {error}=await supabase.from('brand_jobs').update({status:'reviewed',updated_at:new Date().toISOString()}).eq('id',button.dataset.id).eq('status','needs_review');if(error)return message(error.message,'error');await refreshAdmin();await refreshJobs();}));
}

async function loadApp() {
  showLoading();
  const result=await supabase.auth.getSession();session=result.data.session;
  if(!session){authView();return;}
  try {await loadProfile();shell();clearInterval(poller);poller=setInterval(()=>{refreshJobs();if(profile?.role==='admin')refreshAdmin();},7000);}
  catch(error){root.innerHTML=`<main class="fatal"><h1>Không mở được không gian làm việc</h1><p>${safe(error.message)}</p><button class="primary" id="retry-app">Thử lại</button></main>`;on('#retry-app','click',loadApp);}
}

if(!supabase)root.innerHTML='<main class="fatal"><h1>Chưa cấu hình web</h1><p>Cần đặt VITE_SUPABASE_PUBLISHABLE_KEY khi triển khai.</p></main>';
else {supabase.auth.onAuthStateChange((_event,newSession)=>{if(newSession?.user?.id!==session?.user?.id){session=newSession;setTimeout(loadApp,0);}});loadApp();}
