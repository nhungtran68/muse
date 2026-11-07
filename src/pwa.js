import './pwa.css';

let installEvent;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || ios;
const dismissed = () => { try { return Date.now() - Number(localStorage.getItem('muse-install-later') || 0) < 7 * 86400000; } catch { return false; } };
function hide() { document.querySelector('#pwa-invite')?.remove(); }
function show() {
  if (!mobile || standalone() || dismissed() || document.querySelector('#pwa-invite') || (!ios && !installEvent)) return;
  const panel = document.createElement('aside');
  panel.id = 'pwa-invite'; panel.className = 'pwa-invite'; panel.setAttribute('aria-label','Cài ứng dụng Muse Studio');
  panel.innerHTML = '<img src="/icon-192.png" width="48" height="48" alt=""><div class="pwa-copy"><strong>Cài ứng dụng</strong><span>Truy cập Muse Studio nhanh hơn từ màn hình chính.</span><p class="pwa-help" hidden></p><div class="pwa-actions"><button type="button" class="pwa-install">Cài đặt</button><button type="button" class="pwa-later">Để sau</button></div></div>';
  document.body.append(panel);
  panel.querySelector('.pwa-later').addEventListener('click', () => { try { localStorage.setItem('muse-install-later', String(Date.now())); } catch {} hide(); });
  panel.querySelector('.pwa-install').addEventListener('click', async () => {
    if (ios) { const help=panel.querySelector('.pwa-help'); help.textContent='Trong Safari, nhấn Chia sẻ (□↑), chọn “Thêm vào Màn hình chính”, rồi nhấn Thêm. Nếu đang dùng trình duyệt khác, hãy mở trang này trong Safari.'; help.hidden=false; return; }
    if (!installEvent) return;
    const prompt=installEvent; installEvent=null; await prompt.prompt(); const choice=await prompt.userChoice; if(choice.outcome==='accepted') hide(); else { try { localStorage.setItem('muse-install-later',String(Date.now())); } catch {} hide(); }
  });
}
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installEvent=event; show(); });
window.addEventListener('appinstalled', hide);
if (ios) window.addEventListener('load', show);
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').then(registration => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') registration.update().catch(() => {}); });
  }).catch(() => {}));
}
