# Muse Brand Worker 3.0.2

Worker chạy trên máy quản trị viên để dùng tài khoản Muse trên web. Giữ Docker Desktop, container `fb-whisper`, cửa sổ worker và Chrome Muse đang mở khi có yêu cầu. Worker chỉ giữ mật khẩu quản trị web trong phiên chạy; mỗi lần khởi động lại cần nhập mật khẩu trực tiếp trong cửa sổ worker.

## Cách dùng

1. Bảo đảm máy có Node.js 22 trở lên, FFmpeg và FFprobe. Mở Docker Desktop và chạy container `fb-whisper` đã cài mô hình nhận dạng tiếng Việt.
2. Giải nén toàn bộ gói, bấm `01-CAI-DAT.cmd` một lần để cài thư viện.
3. Bấm `02-CHAY-WORKER.cmd`, tự nhập email và mật khẩu quản trị web. Đăng nhập Muse trong Chrome do worker mở nếu được yêu cầu. Chờ dòng **Worker đã sẵn sàng (bản 3.0.0)**.
4. Trên web, quản trị viên bật **Nhận yêu cầu mới**. Thành viên tải một ảnh, nhập nội dung và chọn số đoạn 10 giây.
5. Worker viết kịch bản rồi dừng. Thành viên sửa lời thoại; chỉ nút **Tạo video** mới đưa clip vào hàng đợi. Worker dùng cùng ảnh gốc cho từng clip, kiểm tra tiếng nói và thời lượng, ghép theo thứ tự, rồi trả MP4 vào tài khoản của đúng thành viên.

Chỉ chạy một worker dùng chung tài khoản Muse. Không gửi thư mục `data`, mật khẩu web hoặc mã đăng nhập Muse cho người khác. Trong v3, Muse tạo từng clip 10 giây; yêu cầu giữ mặt và giọng giữa clip được nhắc trong prompt nhưng chưa có điều khiển khóa danh tính/giọng được kiểm chứng. Kiểm tra thành phẩm trước khi dùng công khai.
