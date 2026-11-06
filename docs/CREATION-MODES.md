# Ba chế độ tạo trực tiếp — worker 3.1.0

- **Video 10 giây**: giữ luồng video hiện tại, một ảnh được chuẩn hóa 720 × 1280, một video dọc 10 giây và kiểm tra thời lượng như trước.
- **Video tự do**: nhập độ dài, tỷ lệ và nội dung mong muốn trong prompt. Ảnh không bắt buộc; ảnh đính kèm giữ nguyên tỷ lệ. Website gửi một yêu cầu, Muse tự xử lý/ghép nội bộ. Worker chờ nhiệm vụ dừng và lấy video cuối cùng trong đúng lượt trả lời, kiểm tra tệp và ghi thời lượng thực tế; không cắt về 10 giây hoặc tự chia job.
- **Tạo ảnh**: prompt và ảnh tham chiếu tùy chọn; kết quả phải là PNG/JPEG/WebP đọc được, có kích thước hợp lệ. Ảnh xem và tải về ngay trong thư viện.

Mã job, khóa chống gửi trùng, ảnh, biên nhận Muse và đường dẫn kết quả tách riêng theo tài khoản/job. Mất kết nối giữ biên nhận để nhận tiếp kết quả cũ. Luồng video 10 giây và lịch sử nhiều cảnh cũ vẫn dùng kiểm tra hiện có.

Kết quả ảnh và video dùng chung bucket riêng `brand-videos` với chính sách quyền sở hữu sẵn có. MIME ảnh được thêm vào danh sách cho phép. Cơ chế cron/API hiện có tiếp tục xóa file sau 60 phút; không đổi hạn của dữ liệu cũ. Giới hạn mỗi tệp của kho hiện tại là 50 MB. Hệ thống báo rõ nếu kết quả vượt giới hạn này.

## Triển khai

1. Cập nhật worker và shared modules lên 3.1.0; giữ nguyên thư mục auth và muse-profile.
2. Áp dụng migration `20261106090000_single_media_modes.sql` rồi kiểm tra RPC mới trong schema cache.
3. Cập nhật web. Menu nằm trên ô prompt, mặc định Video 10 giây.

## Kiểm tra

- Bộ kiểm tra trình duyệt bao phủ menu, giữ prompt khi đổi chế độ, gửi không ảnh, chống bấm lặp, hiển thị video/ảnh và tải ảnh đúng đuôi tệp; kiểm tra màn hình 360, 390 và 1440 px.
- Worker xử lý tệp MP4 30 giây và PNG thật từ fixture, một lần gọi Muse giả lập; kiểm tra giữ biên nhận khi timeout.
- Kiểm tra DOM tách ảnh tham chiếu đầu vào, kết quả ở lượt khác và video trung gian khỏi kết quả cuối.
- SQL fixture chạy trong giao dịch rollback của Supabase local: khóa chống trùng, tách chế độ, quyền sở hữu, video 10 giây, commit kết quả hợp lệ và thời hạn 60 phút.

Fixture và Muse thật là hai mức kiểm tra khác nhau. Kết quả thực tế phía Muse phụ thuộc khả năng tài khoản/model ở lần chạy; prompt không bảo đảm tuyệt đối khuôn mặt, giọng nói hoặc thời lượng.

### Kiểm tra Muse thật ngày 2026-11-06

- Job ảnh `ff632d35-f333-47d6-86f0-7256dbff8b02`: hoàn tất, PNG 1600 × 1600; thời hạn xóa do server đặt đúng 60 phút. Lượt thử đầu phát hiện viewer ảnh khác dialog video. Đã sửa để tải tài nguyên ảnh trong đúng phản hồi Muse và nhận lại bằng biên nhận cũ, không gửi lại yêu cầu tạo ảnh.

## Khôi phục

Giữ migration bổ sung và dữ liệu. Dừng nhận yêu cầu mới, để worker 3.1.0 xử lý xong hoặc xác định trạng thái các job `video_free`/`image` trước khi khôi phục worker cũ; worker cũ chưa hiểu hai chế độ này. Web có thể khôi phục deployment trước. Không xóa bảng, volume, phiên đăng nhập hoặc file khách hàng.
