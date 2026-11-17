export const REFERENCE_SIZE = Object.freeze({width:720,height:1280});
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_REFERENCE_IMAGES = 4;

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

export function referenceTileRects(count,width=REFERENCE_SIZE.width,height=REFERENCE_SIZE.height){
  if(!Number.isInteger(count)||count<1||count>MAX_REFERENCE_IMAGES)throw Error(`Chọn từ 1 đến ${MAX_REFERENCE_IMAGES} ảnh tham chiếu.`);
  const gap=12,margin=12,innerWidth=width-2*margin,innerHeight=height-2*margin;
  if(count===1)return [{x:margin,y:margin,width:innerWidth,height:innerHeight}];
  const columnWidth=(innerWidth-gap)/2,rowHeight=(innerHeight-gap)/2;
  if(count===2)return [0,1].map(index=>({x:margin+index*(columnWidth+gap),y:margin,width:columnWidth,height:innerHeight}));
  if(count===3)return [
    {x:margin,y:margin,width:columnWidth,height:innerHeight},
    {x:margin+columnWidth+gap,y:margin,width:columnWidth,height:rowHeight},
    {x:margin+columnWidth+gap,y:margin+rowHeight+gap,width:columnWidth,height:rowHeight}
  ];
  return [0,1,2,3].map(index=>({x:margin+(index%2)*(columnWidth+gap),y:margin+Math.floor(index/2)*(rowHeight+gap),width:columnWidth,height:rowHeight}));
}

export async function normalizeReferenceImages(files,options={}){
  const selected=Array.from(files||[]);
  if(!selected.length)throw Error('Chưa chọn ảnh tham chiếu.');
  if(selected.length>MAX_REFERENCE_IMAGES)throw Error(`Chọn tối đa ${MAX_REFERENCE_IMAGES} ảnh tham chiếu.`);
  if(selected.length===1)return normalizeReferenceImage(selected[0],options);
  for(const file of selected){
    if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.');
    if(!file.size||file.size>MAX_REFERENCE_BYTES)throw Error('Mỗi ảnh phải có dung lượng từ 1 byte đến 10 MB.');
  }
  const {width,height}=REFERENCE_SIZE,canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d',{alpha:false});
  if(!context)throw Error('Trình duyệt không thể xử lý ảnh. Hãy thử lại bằng trình duyệt mới hơn.');
  context.fillStyle='#f5f4f0';context.fillRect(0,0,width,height);
  const tiles=referenceTileRects(selected.length,width,height);
  for(let index=0;index<selected.length;index++){
    let decoded;
    try{decoded=await decodeImage(selected[index]);
      const sourceWidth=decoded.width||decoded.naturalWidth,sourceHeight=decoded.height||decoded.naturalHeight;
      if(!sourceWidth||!sourceHeight)throw Error('Ảnh không có kích thước hợp lệ.');
      const tile=tiles[index],rect=containImageRect(sourceWidth,sourceHeight,tile.width,tile.height);
      context.drawImage(decoded,tile.x+rect.x,tile.y+rect.y,rect.width,rect.height);
    }catch{throw Error(`Không đọc được ảnh ${index+1}. Hãy lưu lại ảnh dưới dạng JPG, PNG hoặc WebP rồi thử lại.`);}
    finally{decoded?.close?.();}
  }
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.94));
  if(!blob?.size||blob.size>MAX_REFERENCE_BYTES)throw Error('Không tạo được khung ảnh tham chiếu dưới 10 MB. Hãy chọn ảnh có độ phân giải thấp hơn.');
  return {file:new File([blob],'reference-composite-9x16.jpg',{type:'image/jpeg'}),width,height,padded:true,collage:true,count:selected.length};
}

export async function normalizeReferenceImage(file,{preserveAspect=false}={}){
  if(!file)throw Error('Chưa chọn ảnh tham chiếu.');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Định dạng ảnh không hỗ trợ. Hãy chọn JPG, PNG hoặc WebP.');
  if(file.size>MAX_REFERENCE_BYTES)throw Error('Ảnh lớn hơn 10 MB. Hãy nén ảnh hoặc chọn ảnh nhỏ hơn rồi thử lại.');
  if(file.size===0)throw Error('Tệp ảnh đang trống. Hãy xuất lại ảnh rồi thử lại.');

  let decoded;
  try{decoded=await decodeImage(file);}catch{throw Error('Không đọc được ảnh (tệp có thể hỏng hoặc không hoàn chỉnh). Hãy lưu lại ảnh dưới dạng JPG, PNG hoặc WebP rồi thử lại.');}
  try{
    const sourceWidth=decoded.width||decoded.naturalWidth,sourceHeight=decoded.height||decoded.naturalHeight;
    if(!sourceWidth||!sourceHeight)throw Error('Ảnh không có kích thước hợp lệ. Hãy xuất lại ảnh rồi thử lại.');
    if(preserveAspect)return {file,sourceWidth,sourceHeight,width:sourceWidth,height:sourceHeight,padded:false,preserved:true};
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
