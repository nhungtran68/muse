const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = value => typeof value === 'string' && ID.test(value);
const MODES = new Set(['video_free', 'image']);
const SELECT = 'id,user_id,content,creation_mode,status,created_at,updated_at,error,error_code,retryable,final_path,storage_provider,output_expires_at,retention_status';

// The caller must inject an independently authenticated Supabase client scoped
// to the linked member. Never use a service-role client here.
export function createMrStudioTools({ client, accessToken, mediaGateway, now = Date.now }) {
  if (!client || !accessToken || typeof mediaGateway !== 'function') throw new Error('Missing authenticated member context');
  async function member() {
    const { data, error } = await client.auth.getUser(accessToken);
    if (error || !data?.user?.id) throw new Error('Phiên đăng nhập đã hết hạn.');
    return data.user.id;
  }
  function publicJob(j) {
    return { id:j.id, content:j.content, mode:j.creation_mode, status:j.status, created_at:j.created_at,
      updated_at:j.updated_at, error:j.error?.replace(/muse(?:\.ai)?/gi,'hệ thống') ?? null,
      error_code:j.error_code, retryable:!!j.retryable, expires_at:j.output_expires_at,
      result_available: j.status === 'done' && !!j.final_path && j.retention_status !== 'expired' && (!j.output_expires_at || Date.parse(j.output_expires_at)>now()) };
  }
  async function find(id) {
    if (!UUID(id)) throw new Error('Mã yêu cầu không hợp lệ.');
    const uid=await member();
    const {data,error}=await client.from('brand_jobs').select(SELECT).eq('user_id',uid).eq('id',id).maybeSingle();
    if(error) throw new Error('Không thể tải yêu cầu.');
    if(!data || data.user_id!==uid) throw new Error('Không tìm thấy yêu cầu.');
    return data;
  }
  return {
    async create({content,mode,requestId,jobId}) {
      if(!MODES.has(mode)) throw new Error('Chỉ hỗ trợ video tự do hoặc tạo ảnh chưa kèm ảnh tham chiếu.');
      if(typeof content!=='string'||content.trim().length<10||content.trim().length>4000) throw new Error('Nội dung cần từ 10 đến 4000 ký tự.');
      if(!UUID(requestId)||!UUID(jobId)) throw new Error('Cần mã yêu cầu và mã tác vụ hợp lệ để tránh tạo trùng.');
      const uid=await member();
      const {data,error}=await client.rpc('submit_single_media_job',{p_id:jobId,p_request_key:requestId,p_content:content.trim(),p_mode:mode,p_reference_sha256:null});
      if(error) throw new Error('Không thể gửi yêu cầu: '+error.message);
      if(!data || data.user_id!==uid) throw new Error('Không xác minh được chủ sở hữu tác vụ.');
      return publicJob(data);
    },
    async status({jobId}) { return publicJob(await find(jobId)); },
    async list({limit=10}={}) {
      if(!Number.isInteger(limit)||limit<1||limit>20) throw new Error('Số lượng phải từ 1 đến 20.');
      const uid=await member();
      const {data,error}=await client.from('brand_jobs').select(SELECT).eq('user_id',uid).order('created_at',{ascending:false}).limit(limit);
      if(error) throw new Error('Không thể tải lịch sử.');
      if(!Array.isArray(data)||data.some(j=>j.user_id!==uid)) throw new Error('Không xác minh được chủ sở hữu tác vụ.');
      return data.map(publicJob);
    },
    async result({jobId}) {
      const j=await find(jobId);if(!publicJob(j).result_available)throw new Error('Kết quả chưa sẵn sàng hoặc đã hết hạn.');
      if(typeof j.final_path!=='string'||!j.final_path.startsWith(`${j.user_id}/${j.id}/`)||j.final_path.includes('\\')||j.final_path.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Đường dẫn kết quả không hợp lệ.');
      if(j.storage_provider==='r2') return {url:await mediaGateway({jobId:j.id,path:j.final_path,token:accessToken}),expires_at:j.output_expires_at};
      const remaining=j.output_expires_at?Math.floor((Date.parse(j.output_expires_at)-now())/1000):600;
      if(!Number.isFinite(remaining)||remaining<1)throw new Error('Kết quả đã hết hạn.');
      const {data,error}=await client.storage.from('brand-videos').createSignedUrl(j.final_path,Math.min(600,remaining),{download:true});
      if(error||!data?.signedUrl)throw new Error('Không thể tạo liên kết tải xuống.');
      return {url:data.signedUrl,expires_at:j.output_expires_at};
    }
  };
}
