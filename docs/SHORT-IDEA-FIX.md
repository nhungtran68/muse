# Sửa luồng ý tưởng ngắn — worker 2.0.2

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
- Khi chạy chính job trên web, đã phát hiện thêm lỗi nhận dạng: “Đại Ngân Farm ạ” bị ghi thành “đại ngân pha mà”, gây báo nhầm `CUT_OFF_SPEECH`. Bản 2.0.2 thử nhận dạng lại cùng file bằng danh sách tên riêng được trích từ chính lời thoại và có trong nội dung gốc. Không cung cấp cả câu mong muốn cho bộ nhận dạng; số tiếng gợi ý tối đa 25% câu, không quá 8 tiếng. Vẫn yêu cầu câu kết khớp, thời gian và độ dài giọng nói đạt chuẩn; bản nhận dạng lại không được tự kéo dài thời điểm kết thúc quá 0,12 giây. Giữ lại cả nhận dạng ban đầu trong nhật ký kiểm tra.
- Sửa thêm dữ liệu trạng thái: cảnh đang chạy lại hoặc đã hoàn tất sẽ xóa `error`/`error_code` của lượt cũ; giữ lại biên nhận, kết quả kiểm tra âm thanh và sự kiện lỗi lịch sử. Quy tắc nằm trong cơ sở dữ liệu, áp dụng được với worker đang chạy và không thay đổi quyền truy cập.

## Kết quả kiểm tra

| Trường hợp | Kết quả |
| --- | --- |
| Bộ kiểm thử tự động toàn dự án bản 2.0.2 | 34/34 đạt, không bỏ qua bài nào |
| Kiểm thử bổ sung tên riêng, lời kết bị cắt và giới hạn từ gợi ý | 3/3 đạt, đã nằm trong bộ kiểm thử toàn dự án |
| Dựng bản web | Đạt |
| Kiểm tra cú pháp và khoảng trắng bản sửa | Đạt |
| Quy tắc xóa lỗi cũ khi chạy lại/thành công | Đạt trên cơ sở dữ liệu Supabase thử riêng; giữ được lỗi mới, biên nhận và kết quả kiểm tra cũ |
| Kiểm tra sau cập nhật cơ sở dữ liệu chính | Mã lỗi cũ trên cảnh hoàn tất đã được xóa, 2 sự kiện lỗi lịch sử vẫn còn; cảnh báo bảo mật trước/sau không đổi |
| Phản hồi giữ chỗ giống lỗi khách gửi | Bị chặn bằng `CONTENT_INSUFFICIENT`, không tạo video |
| Khôi phục nội dung và ảnh của job lỗi | Đạt trong trình duyệt kiểm thử với dữ liệu giả lập |
| Đăng xuất khi ảnh khôi phục còn đang tải, đăng nhập người khác | Không điền nội dung/ảnh người cũ sang tài khoản mới |
| Muse thật, cùng ảnh và cùng ý tưởng ngắn, 3 × 10 giây | Viết được đủ 3 cảnh, mỗi cảnh 27 tiếng; thời gian đọc ước tính 7,88 / 8,08 / 7,78 giây |
| Chính job trên web, worker 2.0.1 | Lập được 3 cảnh, nhận được video cảnh 1 dài 10 giây; dừng do nhận dạng sai tên thương hiệu |
| Video cảnh 1 thật với bộ nhận dạng 2.0.2 | Đạt, giọng nói 7,16 giây; từ vựng tên riêng sửa được lỗi nhận dạng |
| Bản cùng video cố ý cắt mất phần “Farm ạ” | Bị từ chối `CUT_OFF_SPEECH`, giọng nói còn 6,68 giây |
| Tạo và ghép video của chính job trên web bằng worker 2.0.2 | Đạt: cả 3 cảnh dài 10 giây, giọng nói 6,56 / 7,86 / 6,58 giây; job `done`, không còn lỗi hiện hành |
| File ghép cuối cùng | Đạt: 30,042667 giây, 720 × 1280, H.264/AAC, 4.193.471 byte; đọc/giải mã được toàn bộ file |
| Kiểm tra lời thoại trên file ghép | Đạt tự động: có câu kết, sai khác nhận dạng 3,7%; từng cảnh đều đã qua kiểm tra riêng |
| Kiểm tra file và lưu trữ | 3 mã SHA-256 cảnh khác nhau và khớp file thật; kích thước và MD5 của file ghép khớp metadata/ETag trên Supabase; bucket riêng tư, đường dẫn đúng người dùng và job |
| Kiểm tra hình ảnh | Đã xem khung hình của cả 3 cảnh: cùng chủ thể, nón lá, áo xanh và nền trắng theo ảnh tham chiếu |
| Bấm Xem MP4/tải xuống trong phiên trình duyệt của khách | Chưa xác nhận bằng công cụ: Computer Use dừng vì không xác minh được URL hiện tại; không tiếp tục tự động hóa cửa sổ đó |

Phép thử Muse trực tiếp dùng cuộc trò chuyện thử riêng `2d8df960-bb1d-43a9-b056-480eb67e2be2`, chỉ lập kịch bản. Sau đó đã chạy lại **chính yêu cầu trên web chính**, giữ nguyên ảnh, nội dung, số cảnh và mode; kết quả MP4 nêu trên là kết quả của job đó. Hoàn tất ở lượt xử lý thứ 3; hai lần lỗi trước được giữ trong lịch sử, không tăng giới hạn thử lại hoặc bỏ qua kiểm tra âm thanh để đạt kết quả.

Kết quả này xác nhận trường hợp ý tưởng ngắn 3 cảnh, mode 10 giây. Không công bố toàn bộ ứng dụng đạt 100% cho mọi nội dung hoặc mọi mode. Mode 5/8 giây vẫn chưa được bật; âm thanh đã được kiểm tra tự động, chưa nghe duyệt thủ công toàn bộ. Các bài thử nhiều thành viên trước đó được ghi riêng trong `V2-TESTING.md`.

SHA-256 file ghép: `09d17baaca144e66f32c2e36d337ed5a4eb8d46dbce0026da8c44b017ff645a3`.

Tham chiếu kỹ thuật cho tùy chọn từ vựng nhận dạng: [mã nguồn faster-whisper](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py). Khả năng này cũng đã được kiểm tra trên thư viện thật trong container `fb-whisper` của máy.
