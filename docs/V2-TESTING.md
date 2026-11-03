# Kiểm thử Workflow v2

Cập nhật ngày 03/11/2026. Chưa nghiệm thu toàn bộ và chưa cập nhật cơ sở dữ liệu chính. Không coi kiểm thử mô phỏng là kết quả chạy Muse thật.

## Logic đã sửa

- Giữ nguyên nội dung thô, yêu cầu Muse phân tích chủ đề, thông điệp, nhân vật, ngữ cảnh và mục đích; lập dàn ý và đúng số cảnh. Mỗi cảnh có prompt, lời thoại, hành động, thời lượng và trích dẫn nguồn.
- Ước tính tiếng Việt trước khi tạo. Kiểm tra lời nói thực bằng faster-whisper trên máy, gồm độ khớp, phần kết câu, thời điểm kết thúc và thời lượng nói tối thiểu 60% mode. Kiểm tra lại âm thanh sau khi ghép.
- Mỗi người, job và lần xử lý có mã riêng. Hàng đợi FIFO, một quyền thuê worker Muse, gia hạn 20 giây, hết hạn 90 giây; mọi cập nhật kiểm tra mã lần xử lý.
- Khóa chống gửi trùng theo người dùng, khóa yêu cầu và dấu vân tay nội dung/ảnh. File ảnh kiểm tra SHA-256; video lưu bất biến theo user/job/lần xử lý.
- Mỗi job mở cuộc trò chuyện Muse riêng. Chỉ lấy video trong phản hồi của đúng tin nhắn người gửi, trước tin nhắn tiếp theo. Chờ lịch sử tải xong, xác minh đúng URL khi mở lại. Không tự gửi lại yêu cầu đã có biên nhận.
- Cảnh bị loại do thoại có thể tạo lại bằng mã lần tạo mới; giữ các cảnh đã đạt. Lỗi từ Muse được ghi nhận thay vì chờ vô hạn hoặc trả file sai.
- RLS bảo vệ job, cảnh, ảnh và video; thành viên xem lịch sử của mình. Phản hồi chậm từ tài khoản cũ không được hiển thị sau khi đổi tài khoản. Yêu cầu đang gửi dùng phiên của người đã bấm gửi.
- Quản trị xem cả lỗi v2, thử lại khi còn lượt và lỗi cho phép. Không biến job lỗi thành hoàn tất bằng thao tác duyệt.

## Ma trận kết quả hiện có

| Trường hợp | Bằng chứng | Trạng thái |
| --- | --- | --- |
| Một thành viên, một yêu cầu | Worker v2 + Supabase cục bộ thật + Muse, tạo và tải MP4 | Đạt một lượt |
| Một thành viên gửi liên tiếp | Web + Auth/REST/Storage thật, hai job riêng trong lịch sử | Đạt phần gửi; đang chạy chung worker |
| Hai thành viên gửi cùng lúc | Hai job khác ảnh/nội dung/mode, worker tạo đủ kết quả riêng | Đạt một lượt |
| Nhiều người cùng mode khác nội dung | Web tạo hai job 10 giây đồng thời | Đạt phần gửi; đang kiểm tra đầu ra |
| Hai job khác ảnh và thời lượng | Một job 5 giây, một job hai cảnh 10 giây, file không trùng | Đạt một lượt, không đủ để mở mode 5 giây ổn định |
| Một job lỗi, một thành công | Cố ý sai SHA ảnh; job kế tiếp hoàn tất; một video khác bị chặn vì cắt thoại | Đạt một lượt |
| Tải lại trang khi đang xử lý | Trình duyệt mô phỏng trạng thái đang xử lý; web + Supabase thật giữ lịch sử job đã gửi | Đang kiểm tra chung worker thật |
| Lịch sử và quyền dữ liệu | Hai người không đọc được job/cảnh/ảnh/video và URL ký của nhau trên Supabase cục bộ | Đạt |
| Thời lượng thoại | Video hai cảnh 10 giây, file 20,04 giây; lời nói 6,54 và 6,24 giây, tỷ lệ sai từ file ghép 4,3% | Đạt mẫu này |
| Kết quả không trộn file | So đường dẫn, mã job, hash; tải bằng đúng người và chặn người còn lại | Đạt mẫu đã thử |
| Tạo lại sau lỗi thoại/gián đoạn | Mở lại đúng cuộc trò chuyện, đã nhận được video GEN_0 bằng biên nhận, đang chạy GEN_1 | Chưa chốt |
| Đổi tài khoản khi phản hồi đến chậm | Giữ phản hồi người A, đăng nhập B, trả phản hồi A sau đó | Kiểm thử trình duyệt đạt |

23 kiểm thử tự động đã đạt trước lần chỉnh nhãn trợ năng “You” cuối; 5 kiểm thử adapter sau chỉnh cũng đạt. Bản dựng web đạt. Các SQL trong `tools/db-fixtures` chỉ dành cho PostgreSQL thử riêng, không chạy vào cơ sở dữ liệu có khách hàng.

Mode 10 giây được giữ. Mode 5 giây có lượt thành công nhưng có lượt Muse tạo 10 giây và từ chối giao file; tạm khóa. Mode 8 giây đã trả 10 giây trước đó nên khóa. Không tự thay mode.

## Giới hạn và phần còn lại

- Cần hoàn tất lượt dùng chung web/worker thật, xác nhận email trong môi trường thử và kiểm tra sau triển khai. Các tài khoản thử cục bộ hiện đăng ký với xác nhận email tắt.
- Cần hoàn thiện gói worker, cập nhật Supabase/Vercel có phối hợp rồi kiểm tra trên web chính. Worker v1 không được nhận job v2. Dữ liệu chính đang có 1 hồ sơ, 4 job, 12 cảnh và 18 file; chỉ lưu cấu trúc trước khi nâng cấp, không xuất nội dung khách hàng.
- Nhận dạng tiếng nói và kiểm tra trích dẫn có sai số. Chúng không chứng minh mọi chi tiết thương hiệu do Muse viết đều có căn cứ; cần nghe, xem và đọc đối chiếu thêm khi nghiệm thu.
- Cuộc trò chuyện riêng không tắt ký ức chung của tài khoản Muse. Không thể cam kết tuyệt đối rằng mô hình không dùng dữ liệu cũ. Chưa nghiệm thu để phục vụ công khai khách ngoài.

## Cập nhật và khôi phục

Chỉ cập nhật sau khi các kiểm thử cần thiết đạt. Tắt nhận yêu cầu trong lúc chuyển đổi, dừng worker v1, kiểm tra không có job đang chạy, áp dụng 004 rồi 005, triển khai web tương ứng và mở worker v2. Giữ toàn bộ lịch sử và file cũ. Chỉ bật nhận yêu cầu khi worker v2 báo sẵn sàng.

Bản ghi cấu trúc trước nâng cấp được lưu riêng ngoài repo. Nếu cập nhật gặp lỗi, giữ nhận yêu cầu tắt, dừng worker mới và dùng bản ghi cấu trúc để chuẩn bị migration tiến có kiểm tra. Không xóa cột hoặc dữ liệu v2; không chỉ đổi web về v1 rồi bật nhận yêu cầu vì quyền/RPC không tương thích.
