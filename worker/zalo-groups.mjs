export async function syncZaloGroups({client, workerId, leaseToken, bridgeUrl, bridgeToken, fetcher = fetch}) {
  if (!bridgeUrl || !bridgeToken) return;
  const origin = new URL(bridgeUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))) {
    throw Error('INVALID_ZALO_BRIDGE');
  }
  const result = await fetcher(new URL('/api/groups', origin), {
    headers: {'x-bridge-token': bridgeToken}, redirect: 'error', signal: AbortSignal.timeout(25_000)
  });
  if (!result.ok) throw Error('ZALO_GROUPS_UNAVAILABLE');
  const payload = await result.json();
  if (payload.ok !== true || !Array.isArray(payload.groups)) throw Error('INVALID_ZALO_GROUPS');
  const groups = new Map();
  for (const item of payload.groups) {
    const id = typeof item?.groupId === 'string' ? item.groupId : '';
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 150) : '';
    if (/^\d{5,30}$/.test(id) && name) groups.set(id, {id, name});
    if (groups.size >= 500) break;
  }
  const saved = await client.rpc('publish_zalo_groups', {
    p_worker: workerId, p_token: leaseToken, p_groups: [...groups.values()]
  });
  if (saved.error || saved.data !== true) throw Error('ZALO_GROUP_SYNC_FAILED');
}
