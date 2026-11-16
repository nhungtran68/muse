const statusLabels = {
  pending: 'Chờ gửi', sending: 'Đang gửi', sent: 'Đã gửi',
  failed: 'Gửi thất bại', uncertain: 'Chưa xác nhận được', expired: 'Đã hết hạn hoặc đã tắt'
};

export async function mountVideoDelivery(grid, client) {
  if (!grid) return;
  const card = document.createElement('section');
  card.className = 'admin-card full-width';
  card.innerHTML = `
    <h3>Phân phối video</h3>
    <form data-storage>
      <label>Kho lưu file cho yêu cầu mới
        <select name="storage">
          <option value="r2">Cloudflare R2</option>
          <option value="supabase">Supabase Storage</option>
        </select>
      </label>
      <button class="outline" type="submit" disabled>Lưu lựa chọn kho</button>
    </form>
    <form data-zalo>
      <label class="toggle"><input type="checkbox" name="enabled"> Gửi video vào nhóm Zalo</label>
      <label>Mã nhóm Zalo<input name="group" maxlength="100" pattern="[A-Za-z0-9_\\-]{1,100}" autocomplete="off"></label>
      <p class="admin-note">Áp dụng cho video mới do tài khoản quản trị này tạo sau khi bật. Nhóm kết nối qua Zalo OA nhận liên kết tải có thời hạn.</p>
      <button class="outline" type="submit" disabled>Lưu lựa chọn Zalo</button>
    </form>
    <p role="status">Đang tải cài đặt…</p>
    <ul aria-label="Lần gửi Zalo gần đây"></ul>`;
  grid.append(card);
  const storage = card.querySelector('[data-storage]');
  const zalo = card.querySelector('[data-zalo]');
  const status = card.querySelector('[role=status]');
  const list = card.querySelector('ul');

  function showRecent(data) {
    list.replaceChildren(...(data.recent ?? []).map(item => {
      const row = document.createElement('li');
      row.textContent = `${item.job_id.slice(0, 8)} · ${statusLabels[item.state] || 'Chưa rõ'}`;
      return row;
    }));
  }

  async function refresh(initial = false) {
    try {
      const {data, error} = await client.rpc('get_video_delivery_settings');
      if (!card.isConnected) return;
      if (error || typeof data?.r2 !== 'boolean') throw Error();
      if (initial) {
        storage.elements.storage.value = data.r2 ? 'r2' : 'supabase';
        zalo.elements.enabled.checked = data.zalo;
        zalo.elements.group.value = data.group_id || '';
        zalo.elements.group.required = data.zalo;
        for (const button of card.querySelectorAll('button')) button.disabled = false;
        status.textContent = '';
      }
      showRecent(data);
    } catch {
      if (initial) status.textContent = 'Chưa tải được cài đặt phân phối. Hãy tải lại trang.';
    }
  }

  function bindSave(form, rpc, values) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      if (button.disabled) return;
      button.disabled = true;
      try {
        const {data, error} = await client.rpc(rpc, values());
        if (error) throw error;
        if (card.isConnected) {
          showRecent(data);
          status.textContent = 'Đã lưu lựa chọn.';
        }
      } catch {
        status.textContent = 'Chưa lưu được. Hãy kiểm tra thông tin và thử lại.';
      } finally {
        button.disabled = false;
      }
    });
  }
  zalo.elements.enabled.addEventListener('change', () => {
    zalo.elements.group.required = zalo.elements.enabled.checked;
  });
  bindSave(storage, 'set_video_storage', () => ({p_r2: storage.elements.storage.value === 'r2'}));
  bindSave(zalo, 'set_zalo_delivery', () => ({
    p_enabled: zalo.elements.enabled.checked,
    p_group_id: zalo.elements.group.value.trim()
  }));
  await refresh(true);
  const poller = setInterval(() => {
    if (!card.isConnected) clearInterval(poller);
    else void refresh();
  }, 15000);
}
