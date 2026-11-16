# Phân phối video trong Mr Studio

Trong **Quản trị → Phân phối video**, lưu riêng lựa chọn kho và lựa chọn Zalo.
Kho R2 dùng cấu hình hiện có. Đổi kho chỉ áp dụng cho yêu cầu mới và giữ quy tắc xóa file hiện tại.
Zalo mặc định tắt cho mọi tài khoản. Khi bật, chỉ video mới của chính quản trị viên đã bật được gửi tới nhóm họ chọn.

## Cấu hình máy xử lý

- Nhóm Zalo đã kết nối cầu nối video nội bộ: đặt `ZALO_VIDEO_BRIDGE_URL` và `ZALO_VIDEO_BRIDGE_TOKEN` trong môi trường riêng của máy xử lý. Worker gửi file MP4 và đọc biên nhận theo ID tác vụ. Dùng HTTPS hoặc kết nối loopback cùng máy.
- Nhóm Zalo OA (GMF): đặt `ZALO_OA_ACCESS_TOKEN` có quyền quản lý nhóm. Worker gửi liên kết MP4 có hiệu lực tối đa 10 phút. Zalo OA yêu cầu cập nhật token khi hết hạn.

Khởi động lại worker để nạp cấu hình. Khóa chỉ lưu trong môi trường vận hành. Gửi lỗi không đổi trạng thái của video. Khi phía nhận chưa xác nhận, hãy kiểm tra nhóm trước khi gửi thủ công để tránh trùng.

## Triển khai và khôi phục

Áp dụng migration `20261116120000_admin_media_delivery.sql`, sau đó cập nhật website và worker.
Kiểm thử bằng video kiểm tra do quản trị viên tạo trong nhóm chỉ định.
Khi cần dừng, bỏ chọn gửi Zalo trong Quản trị. Có thể đưa web và worker về phiên bản trước và giữ lại các bảng lịch sử. Khôi phục lựa chọn kho về giá trị ban đầu nếu đã đổi.
