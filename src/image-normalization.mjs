export const REFERENCE_SIZE = Object.freeze({width:720,height:1280});
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

export function containImageRect(sourceWidth,sourceHeight,targetWidth=REFERENCE_SIZE.width,targetHeight=REFERENCE_SIZE.height){
  if(![sourceWidth,sourceHeight,targetWidth,targetHeight].every(value=>Number.isFinite(value)&&value>0))throw Error('Kích thước ảnh không hợp lệ.');
  const scale=Math.min(targetWidth/sourceWidth,targetHeight/sourceHeight);
  const width=sourceWidth*scale,height=sourceHeight*scale;
  return {x:(targetWidth-width)/2,y:(targetHeight-height)/2,width,height};
}

function decodeImage(file){
  if(typeof createImageBitmap==='function')return createImageBitmap(file,{imageOrientation:'from-image'});
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file),image=new Image();
    image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};
    image.onerror=()=>{URL.revokeObjectURL(url);reject(Error('Không đọc được ảnh.'));};
    image.src=url;
  });
}

export async function normalizeReferenceImage(file){
  if(!file)throw Error('Chưa chọn ảnh tham chiếu.');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Định dạng ảnh không hỗ trợ. Hãy chọn JPG, PNG hoặc WebP.');
  if(file.size>MAX_REFERENCE_BYTES)throw Error('Ảnh lớn hơn 10 MB. Hãy nén ảnh hoặc chọn ảnh nhỏ hơn rồi thử lại.');
  if(file.size===0)throw Error('Tệp ảnh đang trống. Hãy xuất lại ảnh rồi thử lại.');

  let decoded;
  try{decoded=await decodeImage(file);}catch{throw Error('Không đọc được ảnh (tệp có thể hỏng hoặc không hoàn chỉnh). Hãy lưu lại ảnh dưới dạng JPG, PNG hoặc WebP rồi thử lại.');}
  try{
    const sourceWidth=decoded.width||decoded.naturalWidth,sourceHeight=decoded.height||decoded.naturalHeight;
    if(!sourceWidth||!sourceHeight)throw Error('Ảnh không có kích thước hợp lệ. Hãy xuất lại ảnh rồi thử lại.');
    const {width,height}=REFERENCE_SIZE,rect=containImageRect(sourceWidth,sourceHeight,width,height);
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{alpha:false});
    if(!context)throw Error('Trình duyệt không thể xử lý ảnh này. Hãy thử JPG hoặc PNG bằng trình duyệt mới hơn.');
    context.fillStyle='#f5f4f0';context.fillRect(0,0,width,height);
    context.drawImage(decoded,rect.x,rect.y,rect.width,rect.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.94));
    if(!blob?.size)throw Error('Không tạo được ảnh chuẩn hóa. Hãy thử một ảnh khác hoặc lưu lại dưới dạng JPG.');
    if(blob.size>MAX_REFERENCE_BYTES)throw Error('Ảnh sau khi xử lý vẫn lớn hơn 10 MB. Hãy chọn ảnh có độ phân giải thấp hơn.');
    return {file:new File([blob],'reference-9x16.jpg',{type:'image/jpeg',lastModified:Date.now()}),sourceWidth,sourceHeight,width,height,padded:rect.width<width-1||rect.height<height-1};
  }finally{decoded.close?.();}
}
