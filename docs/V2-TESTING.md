# Muse Studio v2 — báo cáo kiểm tra ngày 03/11/2026

Web chính: https://muse-brand-studio.vercel.app/ — GitHub: https://github.com/nhungtran68/muse

Database và web v2 đã được cập nhật. Worker Windows 2.0.0 đã được cài và kiểm tra thư viện. **Chưa chốt nghiệm thu toàn bộ**: đang chạy lại yêu cầu ba cảnh trên web chính sau khi sửa lỗi đọc JSON trả dở. Không dùng các lượt bị chặn làm bằng chứng tạo video thành công.

## Logic đã sửa

- Nội dung thương hiệu giữ nguyên là đầu vào thô. Muse phân tích chủ đề, thông điệp, nhân vật, ngữ cảnh và mục đích; tạo các cảnh theo thứ tự, kèm prompt, thoại, hành động, thời lượng và trích dẫn nguồn. Dàn ý dạng danh sách được chuẩn hóa; nếu thiếu dàn ý, chỉ tổng hợp từ lời thoại các cảnh đã qua kiểm tra.
- Ước tính tiếng Việt trước khi tạo; kiểm tra âm thanh thật sau mỗi cảnh và sau khi ghép bằng faster-whisper chạy trên máy. Kiểm tra độ khớp, phần kết, mốc kết thúc và thời lượng nói tối thiểu 60% mode. Không gọi thêm API AI.
- Mỗi job có user_id, job_id, thời gian tạo, khóa chống trùng, hash ảnh và mã lần xử lý. Bấm gửi lại trong lúc yêu cầu còn tồn tại không tạo thêm job trùng.
- Hàng đợi FIFO và một quyền thuê worker cho tài khoản Muse, gia hạn 20 giây, hết hạn 90 giây. Mọi cập nhật kiểm tra đúng worker, quyền thuê và mã lần xử lý. Ảnh/file tạm/kết quả tách theo user/job/lần xử lý; video không ghi đè.
- Cảnh đã xong được giữ khi thử lại. Cảnh đã gửi có biên nhận thì chỉ tìm lại đúng kết quả, không gửi trùng. Cảnh bị loại vì thoại có thể dùng mã tạo mới trong giới hạn thử lại.
- Tách cuộc trò chuyện cho từng job; chỉ đọc phản hồi sau đúng tin nhắn người dùng và trước tin nhắn tiếp theo. Không lấy JSON mẫu trong câu hỏi hoặc video của cảnh khác.
- Thành viên chỉ thấy lịch sử, prompt, thoại, ảnh và video của mình. Phản hồi chậm từ tài khoản cũ bị bỏ qua khi đổi đăng nhập. Quản trị xem và xử lý lỗi v2; không đánh dấu job lỗi thành hoàn tất bằng nút duyệt.
- Tác vụ trong database chạy mỗi phút để phát hiện job hết quyền xử lý, chuyển job/cảnh đang tạo sang Lỗi, giữ biên nhận và ghi lịch sử lỗi. Không phụ thuộc worker còn chạy được hay không.

## Lỗi đã phát hiện và xử lý

1. Vòng đọc JSON có thể lặp vô hạn tại vị trí đầu chuỗi khi Muse đang trả dở hoặc trả sai mã. Đã tái hiện bằng tiến trình có timeout: trước sửa bị timeout, sau sửa trả ngay. Cả bộ đọc v1 và v2 đã sửa.
2. Bộ đọc có thể chọn JSON mẫu trong câu hỏi khi mở lại cùng cuộc trò chuyện. Đã giới hạn chỉ phản hồi của trợ lý và dùng mã riêng cho từng lần lập kịch bản.
3. Dàn ý bị kiểm tra quá cứng theo một dạng chuỗi. Đã chấp nhận danh sách chuỗi hoặc tổng hợp từ các cảnh hợp lệ, không bỏ qua các kiểm tra nội dung/thời lượng.
4. Mở lại cuộc trò chuyện có thể chưa tải xong lịch sử hoặc bị chuyển sang URL khác. Đã chờ lịch sử và dừng nếu URL không đúng.
5. Video có thể bị nhận nhầm khi trợ lý nhắc lại mã yêu cầu hoặc có video của tin nhắn sau. Đã giới hạn phạm vi phản hồi theo tin nhắn người dùng.
6. Phản hồi lịch sử cũ có thể cập nhật giao diện sau khi đổi tài khoản. Đã chặn theo người dùng và lượt tải.
7. Worker mất kết nối có thể để job ở Đang xử lý đến khi có worker khác chạy. Đã thêm lịch tự phát hiện hết hạn, kiểm tra thực tế trên database chính.
8. Lệnh khởi động GitHub vẫn trỏ worker v1. Đã chuyển sang v2, dùng npm ci và kiểm tra FFmpeg trước khi gửi việc tạo video.
9. Muse có lúc tạo sai thời lượng 5/8 giây hoặc cắt thoại. Đã khóa 5/8 giây, kiểm tra video/âm thanh và không giao file sai như một kết quả hoàn tất.

## Kết quả từng trường hợp

| Trường hợp | Kết quả và phạm vi |
| --- | --- |
| Một thành viên, một yêu cầu | Đạt qua worker v2, Muse và Supabase cục bộ thật, có MP4 |
| Một thành viên gửi liên tiếp | Đạt: một người có hai job riêng, cả hai tạo và tải đúng file từ web |
| Hai thành viên gửi đồng thời | Đạt qua web/Auth/REST/Storage/Muse/worker thật ở môi trường cục bộ |
| Cùng mode, khác nội dung | Đạt: hai người cùng chọn 10 giây, dùng ảnh/nội dung nho và trà khác nhau |
| Khác ảnh và thời lượng | Đã có lượt 5/10 giây thành công trước đó; bản hiện tại chỉ mở 10 giây vì 5/8 chưa ổn định |
| Một job thành công, một lỗi | Đạt: cố ý sai ảnh bị chặn; job kế tiếp vẫn hoàn tất; thoại bị cắt cũng bị loại |
| Tải lại trang khi worker chạy | Đạt: trạng thái/lịch sử còn đúng và job tiếp tục xử lý |
| Quyền lịch sử và file | Đạt: hai người chỉ thấy dữ liệu riêng; tải bằng đúng người khớp hash, người còn lại bị chặn |
| Thời lượng thoại | Bốn cảnh 10 giây trong lượt thử từ web nói 6,10 / 7,76 / 9,06 / 7,20 giây; file ghép qua kiểm tra lại |
| Kết quả không trộn | Đạt mẫu nho/trà: đường dẫn/hash khác nhau, quyền đúng; đã xem khung hình nho ở giây 2/12 và trà ở giây 2 |
| Thử lại/gián đoạn | Đã nhận lại video cũ bằng biên nhận mà không gửi lại; bản tạo lại bị loại nếu thoại không đạt. Chưa coi một bản bị loại là thành công |
| Đăng ký/xác nhận/đăng nhập | Hai tài khoản cục bộ nhận thư, xác nhận, đăng nhập bằng mật khẩu; trước xác nhận bị chặn, trước duyệt bị chặn tạo job |
| Thành viên trên web chính | Đăng ký và thư xác nhận thật đã đạt với địa chỉ thử thuộc hộp thư quản trị; phiên sau xác nhận có role member, approved=false, thấy 0 job và bị chặn tạo job; đã đăng xuất |
| Worker đứng trên web chính | Đạt: lịch database chạy succeeded và tự chuyển job sang WORKER_INTERRUPTED, giữ quyền thử lại |
| JSON trả dở | 2 kiểm thử timeout tái hiện lỗi trước sửa, đạt sau sửa. Toàn bộ 27/27 kiểm thử tự động và bản dựng đạt |
| Ba cảnh trên bản chính mới nhất | ĐANG THỬ LẠI — job 305ef5ee-00c3-484e-b466-62058ce85e1a |

Lượt web cục bộ thật có ba job hoàn tất: f7029bbc-8799-47b3-91b4-cd3c948f1d39 (trà, 1 cảnh), b5a326da-4330-4220-8fa1-9990e137b975 (nho, 2 cảnh), f9e774c3-94fe-4199-9019-5827f67e9204 (nho, 1 cảnh). File 10/20/10 giây tải về đúng người và đúng hash.

## Triển khai và dữ liệu

- Đã giữ nguyên 4 job cũ, 12 cảnh cũ và 18 file cũ khi nâng cấp. Không xóa hoặc ghi đè kết quả cũ. Một job lỗi cũ v1 vẫn được giữ để quản trị xem lại.
- Migration 004/005 và hai migration hết hạn worker đã áp dụng. Chỉ mode 10 giây bật.
- Có một tài khoản QA thuộc email quản trị trong danh sách thành viên, đang chưa được duyệt và không có job. Không cấp quyền quản trị cho tài khoản thử.
- Gói worker không chứa data/profile/phiên đăng nhập/mật khẩu; thông tin quản trị chỉ ở bộ nhớ lúc chạy. Trạng thái khởi động chỉ lưu mã worker, bước hiện tại và lỗi đã lọc.
- Lỗi của trình kiểm thử được loại khỏi bằng chứng đạt: dữ liệu multipart bị Playwright bỏ phần file, chờ sai tài khoản trong FIFO, xác nhận email bằng đổi fragment trên trang cũ. Bài thử cuối dùng Supabase trực tiếp và mở liên kết email thật.

## Phần chưa thể bảo đảm

- Chưa nghiệm thu 5/8 giây. Không tự thay thành 10 giây hoặc cắt video để che lỗi.
- Nhận dạng giọng nói và kiểm tra trích dẫn có sai số; chưa nghe duyệt thủ công toàn bộ video. Không chứng minh mọi chi tiết do mô hình tạo đều có căn cứ.
- Cuộc trò chuyện riêng không tắt ký ức chung của tài khoản Muse hiện tại. Chưa chứng minh cách ly tuyệt đối ở phía Muse cho mọi nội dung khách ngoài.
- Supabase còn cảnh báo tính năng chống mật khẩu đã rò rỉ chưa bật. Các RPC SECURITY DEFINER có chủ đích và kiểm tra quyền; tài khoản chưa đăng nhập không đọc được job trên API chính.
- Worker và Chrome trên máy quản trị phải tiếp tục mở, máy có mạng. Chưa triển khai worker máy chủ 24/7, tính phí hoặc hủy yêu cầu đang tạo. Ba công cụ ngoài Tạo thương hiệu vẫn là Sắp có.

Không báo hoàn thành 100% hoặc nghiệm thu toàn bộ trên web chính trước khi lượt ba cảnh cuối có MP4 đạt kiểm tra.
