export const CREATION_MODES=Object.freeze([
  {id:'auto',label:'Tạo nội dung',kind:'auto',referenceRequired:false,
    hint:'Ảnh hoặc video theo yêu cầu của bạn',
    placeholder:'Mô tả điều bạn muốn tạo. Nếu cần ảnh, video, thời lượng hoặc tỷ lệ cụ thể, hãy ghi ngay trong yêu cầu.'},
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
export const DIRECT_MEDIA_ACTIONS=Object.freeze(['single_request','single_free_video_request','single_image_request','single_auto_request']);
export function isSingleMediaScene(scene){return DIRECT_MEDIA_ACTIONS.includes(scene?.action);}
export function isFlexibleMediaJob(job){return ['auto','video_free','image'].includes(job?.creation_mode);}

export function buildFlexibleMediaPrompt(job,scene,key){
  if(!isFlexibleMediaJob(job)||job.scene_count!==1)throw Error('Chế độ tạo nội dung không hợp lệ.');
  const content=String(scene?.prompt||job.content||'').trim();
  if(!content)throw Error('Thiếu nội dung yêu cầu.');
  // The new composer sends the customer's request without forcing a media
  // type, duration, orientation, number of scenes, or Muse model.
  if(job.creation_mode==='auto')return `${key}.\n${content}`;
  if(job.reference_kind==='video'){
    if(job.creation_mode!=='video_free'||!job.reference_path)throw Error('Yêu cầu chỉnh sửa phải có video nguồn.');
    return `${key}. Chỉnh sửa đúng tệp VIDEO MP4 ĐÍNH KÈM theo yêu cầu dưới đây. Đây là video nguồn thật cần chỉnh sửa, không phải ảnh tham chiếu. Chỉ sử dụng tệp đính kèm của yêu cầu này; không dùng dữ liệu hoặc kết quả từ cuộc trò chuyện khác.\n\nYÊU CẦU CHỈNH SỬA CỦA KHÁCH:\n${content}\n\nThực hiện đúng những thay đổi khách yêu cầu trên video nguồn và giữ nguyên các phần không được yêu cầu thay đổi. Không tự tạo video mới để thay thế, không chuyển thành tạo video từ ảnh, không tự đổi mô hình hoặc thời lượng. Nếu không thể đọc tệp video hoặc không hỗ trợ thao tác chỉnh sửa, báo rõ lỗi và không tạo một kết quả thay thế. Trả duy nhất một video MP4 đã chỉnh sửa có thể tải xuống; không chỉ xác nhận đã nhận yêu cầu hoặc trả kịch bản. Không đăng lên mạng xã hội hoặc gửi tới nơi khác.`;
  }
  const reference=job.reference_path?'Chỉ dùng ảnh đính kèm làm ảnh tham chiếu; không dùng dữ liệu hoặc ảnh từ yêu cầu khác.':'Không dùng ảnh, dữ liệu hoặc nội dung từ cuộc trò chuyện khác.';
  if(job.creation_mode==='image')return `${key}. Tạo đúng MỘT ảnh theo yêu cầu sau. ${reference}\n\nYÊU CẦU CỦA KHÁCH:\n${content}\n\nHãy tạo ảnh trực tiếp với phong cách, bố cục và tỷ lệ khách yêu cầu. Trả về duy nhất một tệp ảnh PNG, JPEG hoặc WebP có thể tải xuống. Không tạo video, không trả lời chỉ bằng mô tả hoặc kịch bản.`;
  return `${key}. Tạo đúng MỘT video hoàn chỉnh theo yêu cầu sau. ${reference}\n\nYÊU CẦU CỦA KHÁCH:\n${content}\n\nThực hiện độ dài, tỷ lệ và nội dung theo yêu cầu trên; chế độ này không giới hạn video ở 10 giây. Nếu cần nhiều đoạn để thực hiện, hãy tự tạo và ghép bên trong Muse, rồi bàn giao một video MP4 hoàn chỉnh duy nhất đúng thứ tự. Các clip trung gian không phải kết quả cuối cùng. Không tự bịa thông tin thực tế, số liệu, công dụng hoặc cam kết. Không trả lời chỉ bằng kịch bản hay lời giải thích. Không đăng lên mạng xã hội.`;
}
