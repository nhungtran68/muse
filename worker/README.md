# Muse Brand Worker 3.0.6

Worker chạy trên máy quản trị viên và dùng phiên Muse trong hồ sơ Chrome riêng. Sau khi đăng nhập Windows, bộ giám sát tự mở Docker Desktop, chờ `fb-whisper`, khởi động Worker và mở lại Muse. Nếu Docker hoặc Whisper ngừng, bộ giám sát chờ và khôi phục trước khi Worker nhận tác vụ.

## Cách dùng

1. Máy cần Node.js 22 trở lên, FFmpeg/FFprobe và Docker Desktop. Container `fb-whisper` cần có mô hình `faster-whisper-small` trong `/models/hub`.
2. Giải nén toàn bộ gói, bấm `01-CAI-DAT.cmd` một lần. Nếu chưa có phiên quản trị, bấm `03-DANG-NHAP.cmd` và nhập thông tin trực tiếp trong cửa sổ. Đăng nhập Muse trong Chrome riêng khi được yêu cầu. Bộ giám sát sẽ tự chạy từ lần đăng nhập Windows tiếp theo.
3. Dùng `02-CHAY-WORKER.cmd` nếu muốn chạy lại ngay mà không khởi động lại máy. Kiểm tra `startup-status.json` trong `%LOCALAPPDATA%\MuseBrandWorker`; trạng thái `ready` nghĩa là Worker đã nhận quyền và Muse đang sẵn sàng. Nhật ký ở `%LOCALAPPDATA%\MuseBrandWorker\logs\worker.log`.
4. Trên web, quản trị viên bật **Nhận yêu cầu mới**. Thành viên tải một ảnh, nhập bản thô và chọn số đoạn 10 giây. Muse tự phát triển ý ngắn hoặc cô đọng ý dài, giữ thông điệp chính và không tự bịa dữ kiện.
5. Worker viết kịch bản rồi dừng. Thành viên sửa lời thoại; chỉ nút **Tạo video** mới đưa clip vào hàng đợi. Worker dùng cùng ảnh gốc cho từng clip, kiểm tra tiếng nói và thời lượng, ghép theo thứ tự, rồi trả MP4 vào tài khoản của đúng thành viên.

Phiên quản trị được mã hóa bằng Windows DPAPI cho riêng người dùng Windows hiện tại; hồ sơ Chrome Muse được lưu tại `%LOCALAPPDATA%\MuseBrandWorker\muse-profile`. Không gửi hai thư mục này cho người khác. Nếu Muse hủy phiên hoặc yêu cầu xác minh lại, cần đăng nhập lại trong Chrome; phần mềm không thể tự vượt qua xác minh của Muse. Tự chạy bắt đầu sau khi người dùng đăng nhập Windows. Trong v3, Muse tạo từng clip 10 giây; prompt yêu cầu giữ mặt và giọng nhưng Muse không có điều khiển khóa danh tính/giọng được kiểm chứng. Kiểm tra thành phẩm trước khi dùng công khai.
