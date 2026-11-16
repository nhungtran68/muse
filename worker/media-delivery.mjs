import {createHash} from 'node:crypto';
import {downloadMedia, signedMediaUrl} from '../shared/media-storage.mjs';
import {MAX_GENERATED_MEDIA_BYTES} from '../shared/media-limits.mjs';

const GROUP_MESSAGE_URL = 'https://openapi.zalo.me/v3.0/oa/group/message';

export async function deliverNextVideo({
  client, workerId, leaseToken, origin,
  accessToken = process.env.ZALO_OA_ACCESS_TOKEN,
  bridgeUrl = process.env.ZALO_VIDEO_BRIDGE_URL,
  bridgeToken = process.env.ZALO_VIDEO_BRIDGE_TOKEN,
  fetcher = globalThis.fetch, sign = signedMediaUrl, download = downloadMedia, now = Date.now
}) {
  if (!accessToken?.trim() && !(bridgeUrl?.trim() && bridgeToken?.trim())) return 'not_configured';
  const claim = await client.rpc('claim_zalo_delivery', {p_worker: workerId, p_token: leaseToken});
  if (claim.error) throw claim.error;
  const delivery = claim.data;
  if (!delivery) return 'idle';

  let state = 'failed', detail = 'MEDIA_LINK_UNAVAILABLE';
  try {
    const remaining = Math.floor((Date.parse(delivery.expires_at) - now()) / 1000);
    if (remaining < 30 || !Number.isFinite(remaining)) throw Error(detail);
    const media = {
      provider: delivery.storage_provider, bucket: 'brand-videos',
      path: delivery.final_path, jobId: delivery.id, origin,
      expiresIn: Math.min(remaining, 600), download: true
    };
    if (/^\d{5,30}$/.test(delivery.group_id) && bridgeUrl && bridgeToken) {
      const bridge = new URL(bridgeUrl);
      const loopback = ['127.0.0.1','localhost','[::1]'].includes(bridge.hostname);
      if ((!loopback && bridge.protocol !== 'https:') || bridge.username || bridge.password
          || !['http:', 'https:'].includes(bridge.protocol)) throw Error('INVALID_BRIDGE');
      const file = await download(client, media);
      if (!file || file.size < 1024 || file.size > MAX_GENERATED_MEDIA_BYTES) throw Error('INVALID_VIDEO');
      const jobId = createHash('sha256').update('mr-studio:' + delivery.id).digest('hex').slice(0,32);
      const headers = {'x-bridge-token': bridgeToken.trim()};
      state = 'uncertain';
      detail = 'ZALO_RESPONSE_UNCONFIRMED';
      try {
        await fetcher(new URL('/api/send-video', bridge), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
          headers: {...headers, 'Content-Type': 'video/mp4', 'x-job-id': jobId,
            'x-group-id': delivery.group_id,
            'x-message-base64': Buffer.from('Video hoàn tất từ Mr Studio').toString('base64')},
          body: file
        });
      } catch {
        // Ask the bridge for its saved receipt even if the POST response was lost.
      }
      const check = await fetcher(new URL('/api/videos/' + jobId + '/status', bridge), {
        headers, redirect: 'error', signal: AbortSignal.timeout(10_000)
      });
      const receipt = await check.json().catch(() => null);
      if (check.ok && receipt?.ok === true && receipt.confirmed === true) {
        state = 'sent';
        detail = 'ZALO_VIDEO_CONFIRMED';
      } else if (check.ok && receipt?.state === 'failed') {
        state = 'failed';
        detail = 'ZALO_BRIDGE_FAILED';
      }
    } else if (accessToken?.trim()) {
      const url = await sign(client, media);
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password) throw Error(detail);

    // Once the request starts, a network failure leaves the outcome unknown.
    state = 'uncertain';
    detail = 'ZALO_RESPONSE_UNCONFIRMED';
    const response = await fetcher(GROUP_MESSAGE_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', access_token: accessToken.trim()},
      body: JSON.stringify({
        recipient: {group_id: delivery.group_id},
        message: {text: 'Mr Studio: Video đã hoàn tất. Tải MP4 bằng liên kết có thời hạn:\n' + url}
      }),
      signal: AbortSignal.timeout(12_000),
      redirect: 'error'
    });
    const receipt = await response.json().catch(() => null);
    if (response.ok && receipt?.error === 0 && receipt.data?.group_id === delivery.group_id
        && typeof receipt.data.message_id === 'string' && receipt.data.message_id) {
      state = 'sent';
      detail = receipt.data.message_id;
    } else if (Number.isInteger(receipt?.error) && receipt.error !== 0 && response.status < 500) {
      state = 'failed';
      detail = 'ZALO_ERROR_' + receipt.error;
    }
    } else {
      detail = 'ZALO_GROUP_NOT_CONFIGURED';
    }
  } catch {
    // Store only fixed error codes. A signed URL or provider key must stay private.
  }

  const saved = await client.rpc('finish_zalo_delivery', {
    p_job: delivery.id, p_claim: delivery.claim, p_state: state, p_detail: detail
  });
  if (saved.error || saved.data !== true) throw Error('ZALO_RECEIPT_WRITE_FAILED');
  return state;
}
