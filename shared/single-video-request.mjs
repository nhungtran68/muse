export const SINGLE_VIDEO_ACTION='single_request';

export function isSingleVideoScene(scene){
  return scene?.action===SINGLE_VIDEO_ACTION;
}

export function createSingleVideoScene(content,seconds){
  const prompt=String(content||'').trim();
  if(prompt.length<10||prompt.length>4000)throw new Error('Nội dung yêu cầu video không hợp lệ.');
  if(!Number.isInteger(seconds)||![5,8,10].includes(seconds))throw new Error('Chế độ thời lượng video không hợp lệ.');
  return {index:1,seconds,prompt,dialogue:'',action:SINGLE_VIDEO_ACTION,source_quotes:[]};
}

export function buildSingleVideoPrompt(job,scene,key){
  const request=String(scene?.prompt||job?.content||'').trim();
  const seconds=Number(job?.scene_seconds);
  if(!request||![5,8,10].includes(seconds))throw new Error('Thiếu yêu cầu hoặc chế độ tạo video hợp lệ.');
  return `${key}. Đây là MỘT yêu cầu tạo video hoàn chỉnh. Dùng ảnh đính kèm làm ảnh tham chiếu duy nhất. Tạo đúng một video dài ${seconds} giây, khung hình dọc 9:16. Nội dung khách yêu cầu: ${request}\n\nHãy tạo video trực tiếp theo yêu cầu trên, giữ nguyên nhân vật và các chi tiết chính trong ảnh. Nếu yêu cầu có lời nói, thể hiện bằng lời tự nhiên phù hợp; không tự bịa thông tin thực tế, số liệu, công dụng hoặc cam kết. Không trả lời bằng kịch bản hoặc lời giải thích, không chia thành nhiều video hay gửi thêm yêu cầu. Nếu khách yêu cầu nhiều cảnh, thể hiện chúng bên trong cùng một video duy nhất. Trả về duy nhất một video.`;
}
