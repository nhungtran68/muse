# Khởi động Muse từ web

Sau khi cài Worker 3.3.0, chạy `03-DANG-NHAP.cmd` một lần trên máy Windows, đăng nhập quản trị web và Muse nếu được yêu cầu. Máy lưu phiên bằng DPAPI; bộ giám sát tự chạy sau khi người dùng đăng nhập Windows. Trong mục Quản trị của web, trạng thái kết nối được cập nhật từ máy và nút khởi động chỉ gửi lệnh kiểm tra, không dừng hay tạo thêm worker đang chạy.

Máy phải bật, có mạng, Windows đã đăng nhập và bộ giám sát đang chạy. Máy đang tắt/ngủ không nhận được lệnh. Phiên bị nhà cung cấp hủy hoặc yêu cầu xác minh lại phải được đăng nhập trực tiếp. Mã thiết bị chỉ được lưu dưới dạng mã hóa trên máy; cơ sở dữ liệu lưu mã băm và chỉ dùng nó để nhận trạng thái và xác nhận lệnh. Chỉ quản trị viên được duyệt mới xem trạng thái và gửi lệnh.

Để khôi phục phiên bản trước: đưa website về deployment trước và cài lại Worker 3.2.0 từ bản sao lưu mà không xóa `%LOCALAPPDATA%\MuseBrandWorker\auth` hoặc `muse-profile`. Các hàm và bảng của chức năng mới là bổ sung, bản cũ không dùng đến; không cần xóa dữ liệu tác vụ. Nếu cần vô hiệu hóa hẳn, thu hồi quyền gọi `muse_control_poll`, `muse_control_ack`, `muse_control_start`, `muse_control_status`, `muse_control_enroll` sau khi đã khôi phục bản web cũ. Không xóa các bảng hay bucket có dữ liệu khách hàng.
