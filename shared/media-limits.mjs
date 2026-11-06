export const MAX_GENERATED_MEDIA_BYTES=100*1024*1024;

export function assertGeneratedMediaSize(bytes){
  if(!Number.isSafeInteger(bytes)||bytes<1)throw Object.assign(Error('Không đọc được kích thước file kết quả.'),{code:'MEDIA_INVALID',retryable:false});
  if(bytes>MAX_GENERATED_MEDIA_BYTES)throw Object.assign(Error('Kết quả vượt giới hạn 100 MB mỗi file. Hãy giảm độ dài hoặc độ phân giải rồi gửi yêu cầu mới.'),{code:'MEDIA_TOO_LARGE',retryable:false});
}
