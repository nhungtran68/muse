export const CREATION_MODES=Object.freeze([
  {id:'video_10s',label:'Video 10 giây',kind:'video',referenceRequired:true,
    hint:'Một video · 10 giây · dọc 9:16',
    placeholder:'Mô tả video 10 giây bạn muốn tạo. Nêu chủ đề, phong cách, lời nói hoặc hành động nếu cần…'},
  {id:'video_free',label:'Video tự do',kind:'video',referenceRequired:false,
    hint:'Một video hoàn chỉnh · độ dài theo yêu cầu',
    placeholder:'Mô tả video bạn muốn tạo, độ dài và khung hình mong muốn. Hệ thống sẽ tự xử lý và ghép thành một video hoàn chỉnh…'},
  {id:'image',label:'Tạo ảnh',kind:'image',referenceRequired:false,
    hint:'Một ảnh · phong cách và tỷ lệ theo yêu cầu',
    placeholder:'Mô tả ảnh bạn muốn tạo: chủ thể, bối cảnh, màu sắc, phong cách và tỷ lệ ảnh. Có thể thêm ảnh tham chiếu bên dưới…'}
]);

export function getCreationMode(id){return CREATION_MODES.find(mode=>mode.id===id)||CREATION_MODES[0];}
export const DIRECT_MEDIA_ACTIONS=Object.freeze(['single_request','single_free_video_request','single_image_request']);
export function isSingleMediaScene(scene){return DIRECT_MEDIA_ACTIONS.includes(scene?.action);}
export function isFlexibleMediaJob(job){return ['video_free','image'].includes(job?.creation_mode);}

export function buildFlexibleMediaPrompt(job,scene,key){
  if(!isFlexibleMediaJob(job)||job.scene_count!==1)throw Error('Chế độ tạo nội dung không hợp lệ.');
  const content=String(scene?.prompt||job.content||'').trim();
  if(!content)throw Error('Thiếu nội dung yêu cầu.');
  const reference=job.reference_path?'Chỉ dùng ảnh đính kèm làm ảnh tham chiếu; không dùng dữ liệu hoặc ảnh từ yêu cầu khác.':'Không dùng ảnh, dữ liệu hoặc nội dung từ cuộc trò chuyện khác.';
  if(job.creation_mode==='image')return `${key}. Tạo đúng MỘT ảnh theo yêu cầu sau. ${reference}\n\nYÊU CẦU CỦA KHÁCH:\n${content}\n\nHãy tạo ảnh trực tiếp với phong cách, bố cục và tỷ lệ khách yêu cầu. Trả về duy nhất một tệp ảnh PNG, JPEG hoặc WebP có thể tải xuống. Không tạo video, không trả lời chỉ bằng mô tả hoặc kịch bản.`;
  return `${key}. Tạo đúng MỘT video hoàn chỉnh theo yêu cầu sau. ${reference}\n\nYÊU CẦU CỦA KHÁCH:\n${content}\n\nThực hiện độ dài, tỷ lệ và nội dung theo yêu cầu trên; chế độ này không giới hạn video ở 10 giây. Nếu cần nhiều đoạn để thực hiện, hãy tự tạo và ghép bên trong Muse, rồi bàn giao một video MP4 hoàn chỉnh duy nhất đúng thứ tự. Các clip trung gian không phải kết quả cuối cùng. Không tự bịa thông tin thực tế, số liệu, công dụng hoặc cam kết. Không trả lời chỉ bằng kịch bản hay lời giải thích. Không đăng lên mạng xã hội.`;
}
