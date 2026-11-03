# Muse Studio

Web thành viên tạo video từ ảnh tham chiếu, nội dung thô, số cảnh và mode thời lượng. Muse phân tích, lập kịch bản rồi tạo từng cảnh; worker kiểm tra ảnh, video, lời nói và ghép thành MP4. Trạng thái kiểm thử và triển khai được ghi tại [báo cáo v2](docs/V2-TESTING.md).

## Thành phần

- Vercel phục vụ web, không giữ mật khẩu hoặc phiên Muse.
- Supabase quản lý đăng ký, đăng nhập, duyệt thành viên, hàng đợi và kho file riêng. Thành viên đọc dữ liệu của mình; quản trị có quyền vận hành.
- Worker Windows 2.0.0 dùng giao diện Muse trong Chrome riêng. Mỗi job có cuộc trò chuyện và file riêng. Một worker giữ quyền xử lý, các job chạy theo thứ tự; mất quyền thì dừng. Lỗi một job không làm đổi trạng thái của job khác.
- FFmpeg/ffprobe kiểm tra và ghép video. Faster-whisper chạy trên máy kiểm tra lời thoại, không gọi thêm API AI.

Module đầu tiên là **Tạo thương hiệu**. Ba ô còn lại dành cho chức năng tiếp theo. Màn hình rộng hiển thị bốn công cụ mỗi hàng.

## Quản trị và thành viên

Quản trị đầu tiên dùng email `daitaigroup@gmail.com`. Đăng ký và xác nhận email, sau đó đăng nhập. Quyền quản trị được cấp trong Supabase, không dựa vào thông tin người dùng tự gửi.

Quản trị duyệt hoặc khóa thành viên, đặt số cảnh tối đa, hạn mức mỗi ngày và bật nhận yêu cầu. Thành viên có mã riêng, gửi nhiều yêu cầu khác nhau, xem tiến độ, kịch bản và tải kết quả của mình. Yêu cầu trùng đang chạy được gộp bằng khóa và dấu vân tay đầu vào. Thử lại giữ cảnh đã xong, không gửi lại cảnh chưa xác định được kết quả.

## Worker Windows v2

1. Máy cần Node.js 22 trở lên, Chrome hoặc Edge, FFmpeg và ffprobe trong PATH.
2. Cần bộ nhận dạng faster-whisper. Với gói Windows hiện tại, Docker phải chạy container `fb-whisper`, có thư viện và mô hình `small` ở `/models/hub`. Nếu dùng Python trực tiếp, chọn `MUSE_ASR_BACKEND=native` và cài thư viện/mô hình trước.
3. Giải nén toàn bộ gói vào thư mục riêng. Mở `01-CAI-DAT.cmd`. Nếu dùng mã nguồn GitHub, các file CMD nằm trong thư mục `worker`.
4. Sau khi web và cơ sở dữ liệu đã cập nhật v2, dừng worker cũ và mở `02-CHAY-WORKER.cmd`. File này chạy `worker-v2.mjs`.
5. Tự nhập email và mật khẩu quản trị web trong cửa sổ lệnh. Mật khẩu không hiện; phiên quản trị chỉ giữ trong bộ nhớ của lần chạy.
6. Đăng nhập Muse trong cửa sổ Chrome nếu được yêu cầu. Giữ worker và Chrome mở. Chỉ bật nhận yêu cầu sau khi worker báo sẵn sàng.

Profile Muse nằm ở `worker/data/muse-profile`. Không sao chép hoặc đưa thư mục `data`, file xác thực, mật khẩu lên GitHub. Worker v2 không đọc file phiên quản trị v1.

## Mode và giới hạn

- Hiện dùng 10 giây mỗi cảnh, khổ 9:16. Mode 5 và 8 giây bị khóa vì đã có lượt Muse trả 10 giây sai yêu cầu. Không tự thay mode hoặc cắt file để che lỗi.
- Ảnh JPG/PNG/WebP tối đa 10 MB; số cảnh tối đa do quản trị đặt, không quá 8.
- Ước tính tiếng Việt chỉ là bước đầu. Mỗi video cần lời nói khớp, đủ phần kết và dài ít nhất 60% cảnh; file ghép được kiểm tra lại. Không gắn trạng thái hoàn tất khi kiểm tra chưa đạt.
- Kiểm tra trích dẫn không chứng minh mọi chi tiết do mô hình viết đều có căn cứ. Nhận dạng giọng nói có thể sai. Cần xem, nghe đối chiếu thêm trước khi dùng thương mại.
- Các cuộc trò chuyện riêng không tắt ký ức chung của tài khoản Muse. Chưa xác minh cách ly hoàn toàn ở phía Muse khi dùng tài khoản hiện tại cho khách ngoài.
- Chưa có tính phí, thông báo email về job hoặc hủy yêu cầu đang tạo.

## Phát triển và triển khai

```text
npm ci
npm test
npm run build
```

Supabase chính là `wqfzfduccteuycfrymbu`, GitHub là `nhungtran68/muse`. Chỉ khóa publishable được dùng ở web và worker. Không đưa service role key vào mã nguồn. Migration ở `supabase/migrations`; các SQL `tools/db-fixtures` chỉ chạy trong cơ sở dữ liệu thử bỏ đi.

Nâng cấp v2 phải phối hợp database, web và worker. Tắt nhận yêu cầu, dừng worker cũ và kiểm tra không còn job đang chạy. Áp dụng migration 004 rồi 005, triển khai web v2 và khởi động worker v2. Giữ toàn bộ lịch sử/file cũ. Nếu có lỗi, giữ nhận yêu cầu tắt; không chỉ đổi web về v1 rồi mở lại vì RPC/quyền dữ liệu đã thay đổi.
