# Muse Brand Worker cho Windows

Worker chạy trên máy của quản trị viên, mở Chrome hoặc Edge với hồ sơ Muse riêng và lưu phiên đăng nhập trên máy đó.

1. Giải nén toàn bộ ZIP trước khi chạy. Mở thư mục `worker` vừa giải nén.
2. Cài Node.js 22 trở lên và FFmpeg nếu máy chưa có.
3. Bấm đúp `01-CAI-DAT.cmd` và đợi đến dòng **Cai dat hoan tat**. Nếu có lỗi, cửa sổ sẽ dừng để bạn đọc thông báo.
4. Bấm đúp `02-CHAY-WORKER.cmd`. Nhập email và mật khẩu quản trị web trong cửa sổ lệnh. Mật khẩu không hiện khi gõ.
5. Khi trình duyệt mở muse.ai, tự đăng nhập tài khoản Muse. Giữ cửa sổ worker và trình duyệt mở.
6. Trên web, bật **Nhận yêu cầu mới** để gửi thử một video một cảnh bằng tài khoản quản trị. Nếu tạo thành công, giữ công tắc bật để thành viên dùng.

Chỉ chạy một worker tại một thời điểm. Không gửi thư mục `data` hoặc mật khẩu cho người khác. Nếu một tác vụ báo **Cần kiểm tra**, hãy xem kết quả trên Muse trước khi xử lý tiếp trong web.
