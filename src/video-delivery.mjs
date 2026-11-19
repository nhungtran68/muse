const statusLabels = {
  pending: 'Chờ gửi', sending: 'Đang gửi', sent: 'Đã gửi',
  failed: 'Gửi thất bại', uncertain: 'Chưa xác nhận được', expired: 'Đã hết hạn'
};

export function mountVideoOptions(form, mode, client, isAdmin) {
  const options = document.createElement('fieldset');
  options.hidden = true;
  options.className = 'video-delivery-options';
  options.innerHTML = `<legend>Nơi lưu kết quả</legend>
    <label hidden><input type="checkbox" name="output-r2"> Lưu kết quả vào Cloudflare R2</label>
    <label hidden><input type="checkbox" name="output-zalo"> <span>Gửi video vào nhóm Zalo</span></label>
    <small hidden>Khi bỏ chọn R2, kết quả dùng kho mặc định, giới hạn 50 MB. Zalo chỉ nhận kết quả video.</small>`;
  form.querySelector('.composer-bottom').before(options);
  const r2 = options.querySelector('[name=output-r2]');
  const zalo = options.querySelector('[name=output-zalo]');
  const hint = options.querySelector('small');
  let permission = {};
  const sync = () => {
    const video = mode.value !== 'image';
    const showR2 = video && (isAdmin || permission.r2 === true);
    const showZalo = video && (isAdmin || Boolean(permission.zalo_group));
    options.hidden = !showR2 && !showZalo;
    r2.parentElement.hidden = !showR2;
    zalo.parentElement.hidden = !showZalo;
    r2.disabled = !showR2 || permission.r2 !== true;
    zalo.disabled = !showZalo || !permission.zalo_group;
    if (r2.disabled) r2.checked = false;
    if (zalo.disabled) zalo.checked = false;
    hint.hidden = !showR2;
    zalo.value = permission.zalo_group_id || '';
    zalo.nextElementSibling.textContent = permission.zalo_group
      ? `Gửi video vào Zalo · ${permission.zalo_group}`
      : 'Gửi video vào Zalo · Chọn nhóm trong Quản trị';
  };
  async function refresh() {
    const {data, error} = await client.rpc('my_video_distribution');
    if (options.isConnected && !error) {
      if (permission.zalo_group_id !== data?.zalo_group_id) zalo.checked = false;
      permission = data || {};
      sync();
    }
  }
  form.addEventListener('video-distribution-refresh', refresh);
  void refresh();
  const poll = setInterval(() => {
    if (!options.isConnected) clearInterval(poll);
    else if (form.dataset.busy !== 'true') void refresh();
  }, 15000);
  return sync;
}

export async function mountVideoDelivery(grid, client) {
  if (!grid) return;
  const card = document.createElement('section');
  card.className = 'admin-card full-width';
  card.innerHTML = `<h3>Phân phối video</h3>
    <form data-zalo>
      <label>Nhóm Zalo của quản trị viên<select name="group"></select></label>
      <p class="admin-note">Hệ thống dùng nhóm này khi bạn tích gửi Zalo lúc tạo video.</p>
      <button class="outline" type="submit" disabled>Lưu nhóm của tôi</button>
    </form>
    <form data-members>
      <h4>Cấp quyền cho thành viên</h4>
      <label>Thành viên<select name="member" required><option value="">Chọn thành viên</option></select></label>
      <label class="toggle"><input type="checkbox" name="r2" disabled> Cho phép lưu video vào R2</label>
      <label>Nhóm Zalo được chỉ định<select name="group" disabled></select></label>
      <button class="outline" type="submit" disabled>Lưu quyền thành viên</button>
    </form>
    <p data-group-status class="admin-note" aria-live="polite"></p>
    <p role="status">Đang tải cài đặt…</p>
    <ul aria-label="Lần gửi Zalo gần đây"></ul>`;
  grid.append(card);
  const zalo = card.querySelector('[data-zalo]');
  const members = card.querySelector('[data-members]');
  const status = card.querySelector('[role=status]');
  const groupStatus = card.querySelector('[data-group-status]');
  const list = card.querySelector('ul');
  const groupSelects = [zalo.elements.group,members.elements.group];
  const savedGroups = ['', ''];
  let signature;
  let memberRevision = 0;

  function showRecent(data) {
    list.replaceChildren(...(data.recent || []).map(item => {
      const row = document.createElement('li');
      row.textContent = `${item.job_id.slice(0,8)} · ${statusLabels[item.state] || 'Chưa rõ'}`;
      return row;
    }));
  }

  function updateGroups(groups) {
    groupSelects.forEach((select,index) => {
      const wanted = savedGroups[index];
      select.replaceChildren(new Option('Không chọn nhóm Zalo',''),
        ...groups.map(g => new Option(g.name,g.id)));
      if (wanted && !groups.some(g => g.id === wanted)) {
        const unavailable = new Option('Nhóm đã lưu tạm thời không khả dụng',wanted);
        unavailable.disabled = true;
        select.add(unavailable);
      }
      select.value = wanted;
    });
  }

  async function refreshGroups(force = false) {
    const {data,error} = await client.rpc('list_zalo_groups');
    if (!card.isConnected) return;
    const groups = !error && Array.isArray(data?.groups) ? data.groups : [];
    const next = JSON.stringify(groups);
    if (force || signature !== next) {
      signature = next;
      updateGroups(groups);
    }
    groupStatus.textContent = data?.available
      ? (groups.length ? '' : 'Tài khoản Zalo đang kết nối hiện không có nhóm.')
      : 'Đang chờ máy xử lý đồng bộ danh sách nhóm Zalo.';
  }
  groupSelects.forEach((select,index) => select.addEventListener('change',() => {
    savedGroups[index] = select.value;
  }));

  async function loadMembers() {
    const {data,error} = await client.from('profiles').select('id,email,phone')
      .eq('role','member').eq('approved',true).order('created_at',{ascending:false});
    if (!card.isConnected || error) return;
    const select = members.elements.member;
    const current = select.value;
    select.replaceChildren(new Option('Chọn thành viên',''),
      ...data.map(item => new Option(item.phone||item.email||item.id,item.id)));
    if (data.some(item => item.id===current)) select.value = current;
  }

  async function loadAccess() {
    const revision = ++memberRevision;
    const id = members.elements.member.value;
    const fields = [members.elements.r2,members.elements.group,members.querySelector('button')];
    for (const field of fields) field.disabled = true;
    members.elements.r2.checked = false;
    savedGroups[1] = '';
    if (!id) {
      members.elements.group.value = '';
      return;
    }
    const {data,error} = await client.rpc('member_video_distribution',{p_member:id});
    if (revision !== memberRevision || !card.isConnected) return;
    if (error) { status.textContent = 'Chưa đọc được quyền của thành viên.'; return; }
    members.elements.r2.checked = data.r2;
    savedGroups[1] = data.group_id || '';
    await refreshGroups(true);
    if (revision === memberRevision && members.elements.member.value === id) {
      for (const field of fields) field.disabled = false;
    }
  }
  members.elements.member.addEventListener('change',loadAccess);

  function bindSave(form,rpc,values) {
    form.addEventListener('submit',async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      if (button.disabled) return;
      const target = form===members ? members.elements.member.value : null;
      button.disabled = true;
      try {
        const {data,error} = await client.rpc(rpc,values());
        if (error) throw error;
        if (!card.isConnected) return;
        if (form===zalo) {
          showRecent(data);
          document.querySelector('#create-form')?.dispatchEvent(new Event('video-distribution-refresh'));
        }
        status.textContent = form===zalo ? 'Đã lưu nhóm của bạn.' : 'Đã lưu quyền thành viên.';
      } catch {
        status.textContent = 'Chưa lưu được. Kiểm tra thành viên và nhóm Zalo đã chọn.';
      } finally {
        if (form!==members || members.elements.member.value===target) button.disabled = false;
      }
    });
  }
  bindSave(zalo,'choose_zalo_group',() => ({
    p_enabled: Boolean(zalo.elements.group.value),p_group_id:zalo.elements.group.value
  }));
  bindSave(members,'member_video_distribution',() => ({
    p_member:members.elements.member.value,p_r2:members.elements.r2.checked,
    p_group:members.elements.group.value
  }));

  const {data,error} = await client.rpc('get_video_delivery_settings');
  if (!card.isConnected) return;
  if (error) { status.textContent = 'Chưa tải được cài đặt phân phối.'; return; }
  savedGroups[0] = data.zalo ? (data.group_id || '') : '';
  await Promise.all([refreshGroups(true),loadMembers()]);
  zalo.querySelector('button').disabled = false;
  showRecent(data);
  status.textContent = '';
  const poll = setInterval(async () => {
    if (!card.isConnected) { clearInterval(poll); return; }
    await Promise.all([refreshGroups(),loadMembers()]);
    const response = await client.rpc('get_video_delivery_settings');
    if (card.isConnected && !response.error) showRecent(response.data);
  },15000);
}
