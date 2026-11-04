import {estimateSpeech} from './storyboard.mjs';

// This is the approved production template. Script generation never edits it.
export const BRAND_VIDEO_TEMPLATE_VERSION='brand-video-10s-v1';
export const BRAND_VIDEO_TEMPLATE=`Dùng ảnh tĩnh đã tải lên làm hình ảnh tham chiếu duy nhất để tạo video người thật đang chia sẻ trực tiếp với khán giả.

Tạo video gồm {{SO_DOAN}} đoạn liên tiếp, mỗi đoạn dài chính xác 10 giây, tổng thời lượng {{TONG_GIAY}} giây, khung hình dọc 9:16.

NHÂN VẬT VÀ BỐI CẢNH PHẢI ĐƯỢC KHÓA CỨNG:

Giữ nguyên khuôn mặt của nhân vật giống 100% ảnh gốc trong toàn bộ video. Tuyệt đối không thay đổi khuôn mặt, đường nét, mắt, mũi, miệng, làn da, kiểu tóc, tuổi, vóc dáng hoặc trang phục. Không sử dụng tính năng tối ưu khuôn mặt, làm đẹp, chỉnh da, làm mịn da, trẻ hóa hoặc tạo khuôn mặt mới. Không được làm nhân vật đẹp hơn hoặc khác đi so với ảnh gốc.

Giữ nguyên hoàn toàn bối cảnh, phông nền, ánh sáng, góc máy, bố cục và vị trí nhân vật trong toàn bộ {{SO_DOAN}} đoạn. Không đổi cảnh, không đổi quần áo, không thêm người, không thêm vật thể, không thêm máy quay, điện thoại, micro, chữ hoặc logo mới.

Khóa một giọng nói duy nhất xuyên suốt toàn bộ video. Không thay đổi người nói hoặc tạo lại một giọng khác giữa các đoạn.

Nhân vật đứng hoặc ngồi yên tại chỗ, nhìn thẳng vào camera và nói chuyện tự nhiên. Chỉ được chuyển động nhẹ ở miệng, mắt, đầu và hai tay. Cử chỉ tay nhỏ, chậm và tự nhiên như đang chia sẻ. Không đi lại, không xoay người, không nhảy, không múa, không có động tác phóng đại, không biểu cảm quá mức. Máy quay cố định, không rung, không zoom, không lia máy, không cắt cảnh.

Khẩu hình phải khớp chính xác với lời thoại tiếng Việt. Giữ cùng một giọng nói, cùng cao độ, cùng tốc độ, cùng âm sắc, cùng giọng địa phương và cùng phong cách nói trong toàn bộ {{SO_DOAN}} đoạn. Video phải chân thật như người thật đang nói trước camera.

Nhân vật chỉ đọc phần lời thoại được cung cấp. Không đọc tiêu đề đoạn hoặc các chỉ dẫn kỹ thuật. Không tự thêm, bớt hoặc viết lại lời thoại. Không tăng tốc bất thường để nhồi lời thoại vào thời lượng.

KỊCH BẢN TỪNG ĐOẠN:

{{DANH_SACH_DOAN}}

Yêu cầu cuối cùng: Không thay đổi khuôn mặt, không làm đẹp, không đổi cảnh, không đổi trang phục, không đổi giọng, không thêm vật thể và không tạo bất kỳ nhân vật mới nào. Toàn bộ {{SO_DOAN}} đoạn phải có tính liên tục cao, giống như được quay trong cùng một lần duy nhất.`;

export function validateEditedDialogue(dialogue,index){
  if(typeof dialogue!=='string'||!dialogue.trim()||dialogue.length>600)throw Error(`Đoạn ${index}: lời thoại trống hoặc quá dài.`);
  if(/\{\{|\}\}|…/.test(dialogue))throw Error(`Đoạn ${index}: hãy thay biến mẫu hoặc dấu … bằng lời thoại thật.`);
  const speech=estimateSpeech(dialogue,10);
  if(speech.estimated_seconds<5.7||speech.estimated_seconds>9.5)throw Error(`Đoạn ${index}: lời thoại ước tính ${speech.estimated_seconds} giây; hãy viết vừa nhịp nói 10 giây.`);
  return speech;
}

export function compileBrandVideoPrompt(sceneCount,dialogues){
  if(!Number.isInteger(sceneCount)||sceneCount<1||sceneCount>8||!Array.isArray(dialogues)||dialogues.length!==sceneCount)throw Error('Số đoạn và kịch bản không khớp. Hãy cập nhật kịch bản.');
  const list=dialogues.map((dialogue,i)=>{
    validateEditedDialogue(dialogue,i+1);
    const continuity=i===0?'':'Tiếp tục sử dụng đúng nhân vật, khuôn mặt, trang phục, bối cảnh, ánh sáng, góc máy và giọng nói của đoạn trước. Duy trì tư thế và chuyển động tự nhiên để nối liền với đoạn trước.\n';
    return `ĐOẠN ${i+1} – 10 GIÂY:\n${continuity}Lời thoại: “${dialogue}”`;
  }).join('\n\n');
  const prompt=BRAND_VIDEO_TEMPLATE.replaceAll('{{SO_DOAN}}',String(sceneCount)).replaceAll('{{TONG_GIAY}}',String(sceneCount*10)).replace('{{DANH_SACH_DOAN}}',list);
  if(/\{\{|\}\}|…/.test(prompt))throw Error('Mẫu prompt còn biến chưa thay.');
  return prompt;
}

// Muse currently returns one ten-second clip per request. The full fixed
// template is included verbatim for every clip; this operational prefix scopes
// just the clip being requested while the worker later joins them in order.
export function clipRequest(job,scene){
  if(job.schema_version!==3||job.scene_seconds!==10||job.video_prompt_version!==BRAND_VIDEO_TEMPLATE_VERSION)throw Error('Cấu hình mẫu prompt của yêu cầu không khớp bản worker.');
  const plan=job.plan;
  if(!Array.isArray(plan)||plan.length!==job.scene_count||plan.some((part,i)=>part.index!==i+1||part.seconds!==10))throw Error('Kịch bản đã duyệt không khớp số đoạn.');
  const selected=plan[scene.index-1];
  if(!selected||selected.dialogue!==scene.dialogue)throw Error('Lời thoại đoạn không khớp kịch bản đã duyệt.');
  const full=compileBrandVideoPrompt(job.scene_count,plan.map(part=>part.dialogue));
  return `CHỈ THỰC HIỆN ĐOẠN ${scene.index}/${job.scene_count} TRONG LƯỢT NÀY. Tạo đúng MỘT clip 10 giây, khung dọc 9:16, rồi trả MP4. Phần tổng thời lượng trong mẫu dưới đây mô tả video sau khi hệ thống ghép các clip, không yêu cầu tạo cả chuỗi trong lượt này. Chỉ đọc nguyên văn lời thoại của ĐOẠN ${scene.index}; không đọc lời thoại đoạn khác, tiêu đề hay chỉ dẫn. Nói tiếng Việt miền Nam tự nhiên ở nhịp khoảng 2,5 đến 3 từ mỗi giây, ngắt nghỉ vừa phải; đọc hết câu vào khoảng giây thứ 8 đến 9. Không đọc gấp, không kéo dài âm bất thường và không thay đổi lời thoại. Dùng ảnh tham chiếu gốc đính kèm của yêu cầu này. Giữ cùng nhân vật, trang phục, bối cảnh và giọng nói như các đoạn trước trong cùng cuộc trò chuyện. Nếu không thể đáp ứng thời lượng hoặc ảnh tham chiếu, hãy báo lỗi, không tự đổi cấu hình.\n\n${full}`;
}
