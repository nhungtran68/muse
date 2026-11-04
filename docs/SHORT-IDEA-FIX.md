# Sửa luồng ý tưởng ngắn — worker 2.0.1

Ngày kiểm tra: 04/11/2026. Web: https://muse-brand-studio.vercel.app/.

## Lỗi được xác nhận

Yêu cầu `e705b190-5612-4c35-89e7-1f63f3cc244b` có nội dung “Giơi thiệu về đại ngân farm”, chọn 3 cảnh, 10 giây/cảnh. Worker 2.0.0 chỉ cho phép chia dữ liệu gốc, đồng thời yêu cầu mọi cảnh đủ lời thoại. Muse hiểu rằng trích dẫn đã được dùng hết ở cảnh đầu, sửa ba lần rồi trả hai cảnh giữ chỗ. Job dừng ở `STORYBOARD_INVALID`, chưa gửi lệnh tạo video.

## Logic đã sửa

- Xem nội dung khách nhập là nguyên liệu để biên tập; nhận biết ý tưởng ngắn theo lượng nội dung và tổng số cảnh.
- Cho phép Muse viết lời chào, dẫn chuyện, chuyển ý, kết thúc và mô tả chi tiết thấy trong ảnh. Không tự thêm dữ kiện về sản phẩm, công dụng, địa chỉ, ưu đãi, số liệu hoặc cam kết.
- Một trích dẫn có thể làm căn cứ cho nhiều cảnh có nội dung khác nhau; không có quy tắc “dùng hết trích dẫn”. Vẫn kiểm tra nguyên văn trích dẫn, thời lượng đọc, số cảnh và câu bị lặp.
- Chặn cảnh giữ chỗ trước khi kiểm tra độ dài hoặc tạo bất kỳ video nào. `needs_input`/cảnh “chờ bổ sung” chuyển sang lỗi rõ ràng `CONTENT_INSUFFICIENT`, không gửi lặp cùng yêu cầu vô ích.
- Web giải thích cách AI xử lý ý tưởng ngắn. Yêu cầu lỗi kịch bản có nút **Chỉnh nội dung**, lấy lại đúng ảnh và dữ liệu của người sở hữu; kiểm tra mã băm ảnh và ngăn kết quả tải chậm đi vào tài khoản khác sau đăng xuất.
- Worker ghi phiên bản trong trạng thái khởi động và dòng sẵn sàng để xác nhận đúng bản đang chạy. Không thay đổi quyền thành viên, hàng đợi hoặc giới hạn thử lại.

## Kết quả kiểm tra

| Trường hợp | Kết quả |
| --- | --- |
| Bộ kiểm thử tự động toàn dự án | 31/31 đạt, không bỏ qua bài nào |
| Dựng bản web | Đạt |
| Kiểm tra cú pháp và khoảng trắng bản sửa | Đạt |
| Phản hồi giữ chỗ giống lỗi khách gửi | Bị chặn bằng `CONTENT_INSUFFICIENT`, không tạo video |
| Khôi phục nội dung và ảnh của job lỗi | Đạt trong trình duyệt kiểm thử với dữ liệu giả lập |
| Đăng xuất khi ảnh khôi phục còn đang tải, đăng nhập người khác | Không điền nội dung/ảnh người cũ sang tài khoản mới |
| Muse thật, cùng ảnh và cùng ý tưởng ngắn, 3 × 10 giây | Viết được đủ 3 cảnh, mỗi cảnh 27 tiếng; thời gian đọc ước tính 7,88 / 8,08 / 7,78 giây |
| Tạo và ghép video của chính job trên web bằng worker 2.0.1 | Chờ khởi động lại worker và kiểm tra; chưa nghiệm thu bước này |

Phép thử Muse trực tiếp dùng cuộc trò chuyện thử riêng `2d8df960-bb1d-43a9-b056-480eb67e2be2`, chỉ lập kịch bản. Kết quả đó chưa chứng minh đã tạo được MP4. Chưa công bố hoàn thành toàn bộ luồng. Mode 5/8 giây vẫn chưa được bật.
