# Muse Brand Worker cho Windows

Worker chạy trên máy của quản trị viên, mở Chrome hoặc Edge với hồ sơ Muse riêng và lưu phiên đăng nhập trên máy đó.

1. Giải nén toàn bộ ZIP trước khi chạy. Mở thư mục `worker` vừa giải nén.
2. Cài Node.js 22 trở lên và FFmpeg nếu máy chưa có.
3. Bấm đúp `01-CAI-DAT.cmd` và đợi đến dòng **Cai dat hoan tat**. Nếu có lỗi, cửa sổ sẽ dừng để bạn đọc thông báo.
4. Bấm đúp `02-CHAY-WORKER.cmd`. Nhập email và mật khẩu quản trị web trong cửa sổ lệnh. Mật khẩu không hiện khi gõ.
5. Khi trình duyệt mở muse.ai, tự đăng nhập tài khoản Muse. Giữ cửa sổ worker và trình duyệt mở.
6. Trên web, bật **Nhận yêu cầu mới** để gửi thử một video một cảnh bằng tài khoản quản trị. Nếu tạo thành công, giữ công tắc bật để thành viên dùng.

Chỉ chạy một worker tại một thời điểm. Không gửi thư mục `data` hoặc mật khẩu cho người khác. Nếu một tác vụ báo **Cần kiểm tra**, hãy xem kết quả trên Muse trước khi xử lý tiếp trong web.

## Cập nhật 1.5.0

Worker nhận video theo yêu cầu của từng cảnh, thay cho việc đếm tổng số nút video trong lịch sử. Sau khi tải MP4, worker đóng phần xem trước và chờ ô chat sẵn sàng trước khi gửi cảnh tiếp theo.

Khi cập nhật, đóng worker và Chrome của worker rồi mở lại `02-CHAY-WORKER.cmd`. Dòng đầu phải ghi **Muse Brand Worker v1.5.0**. Giữ thư mục `data` để giữ phiên đăng nhập và các MP4 đã tải; không cần cài lại thư viện nếu đã dùng bản trước.

Worker lưu đường dẫn cuộc chat và dấu nhận yêu cầu theo từng cảnh. Khi tiếp tục tác vụ gián đoạn, worker lấy lại kết quả đã gửi, giữ các cảnh hoàn tất và MP4 đã tải. Nếu không tìm thấy đúng cuộc chat, worker dừng để quản trị kiểm tra. Nhật ký nằm ở `data/worker.log`.

Các kiểm tra tự động dùng giao diện mô phỏng không kết nối Muse, gồm ba cảnh khi số thẻ video không tăng, đóng xem trước, tải MP4, chống gửi trùng và tiếp tục ghép video 30 giây. Cần kiểm chứng lại bằng lượt tạo thật trên Muse trước khi coi lỗi thực tế đã được xử lý hoàn toàn.
