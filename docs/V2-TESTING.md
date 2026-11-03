# Workflow v2: kiểm thử và giới hạn hiện tại

Đây là nhánh phát triển, chưa được triển khai. Không chạy migration v2 trên cơ sở dữ liệu đang phục vụ trước khi hoàn tất kiểm thử tổng thể và chuẩn bị phương án khôi phục các RPC/chính sách v1. Worker v1 không thể nhận tác vụ sau khi migration v2 được áp dụng.

## Đã kiểm tra

- Kiểm thử tự động kịch bản: căn thời lượng ước tính, từ quá ngắn/quá dài, lặp thoại, số liệu và trích dẫn không có trong nội dung gốc, so sánh bản nhận dạng lời nói với lời thoại.
- Kiểm thử worker dùng video mẫu cục bộ và dịch vụ giả lập: ảnh đầu vào, đường dẫn file, biên nhận và kết quả của hai job tách biệt.
- PostgreSQL 16 chạy riêng với bảng Auth/Storage giả lập: phân quyền dữ liệu, scene và tên file; gửi trùng và gửi đồng thời; khóa worker; lỗi một job không chặn job tiếp theo; kiểm tra không thể hoàn tất khi thiếu xác minh lời thoại cuối.
- Supabase cục bộ với Auth, PostgREST và Storage thật: tạo và đăng nhập hai thành viên thử, gửi đồng thời hai job với hai ảnh và hai mode khác nhau; tải ảnh, xếp hàng, kiểm tra RLS và đường dẫn video có thời hạn. Một job được đánh dấu hoàn tất bằng video Muse đã kiểm tra, job còn lại bị gây lỗi có chủ đích và được chủ sở hữu thử lại. Xác nhận email tắt trong cấu hình thử; thử nghiệm này chưa chạy toàn bộ worker tạo video.
- Muse thực tế tạo và ghép hai video 10 giây thành file 20,04 giây, 720×1280. Nhận dạng lời nói khớp chữ trong cả hai cảnh và file ghép. Tuy nhiên cảnh hai chỉ nói 2,76 giây; mẫu này **không đạt** yêu cầu về thời lượng thoại. Logic mới đã được chỉnh để phát hiện và từ chối trường hợp đó; cần kiểm tra lại toàn bộ đầu ra thật sau sửa đổi.
- Lần thử sau khi điều chỉnh: Muse tạo hai cảnh 10 giây và ghép thành 20,04 giây; bộ nhận dạng cục bộ xác nhận cảnh một nói 6,54 giây, cảnh hai nói 6,24 giây và lời thoại file ghép khớp (tỉ lệ sai từ 4,3%). Đây là một lượt thử trực tiếp Muse, chưa phải kiểm thử qua web/Supabase/worker đầy đủ.
- Hai nội dung mẫu và hai ảnh mẫu đã được Muse phân tích trong hai cuộc trò chuyện riêng. Kiểm tra cụ thể không thấy tên thương hiệu của yêu cầu này xuất hiện trong kịch bản yêu cầu kia; không suy rộng thành bảo đảm tuyệt đối.
- Một cảnh 5 giây đã được Muse tạo đúng thời lượng 5 giây, 720×1280; kiểm tra cục bộ xác nhận lời thoại khớp, nói trong 2,42 giây. Cần thử nhiều lần và kiểm thử qua toàn bộ ứng dụng.
- Trình duyệt đã thử tải lại trang trong khi job đang xử lý bằng dịch vụ mô phỏng; trạng thái và lịch sử của hai tài khoản mẫu vẫn được hiển thị riêng.

Các SQL tại `tools/db-fixtures` chỉ dành cho cơ sở dữ liệu PostgreSQL dùng một lần, không có dữ liệu thật. `bootstrap-test.sql` mô phỏng Auth và Storage, vì vậy không chứng minh quy trình đăng ký, xác nhận email, tải file hoặc URL có chữ ký của Supabase hoạt động. Chạy các migration theo thứ tự sau bootstrap, sau đó `queue-and-rls-test.sql`, `concurrent-check.mjs`, `output-isolation-test.sql` và `suspended-user-test.sql`.

## Chưa nghiệm thu

- Đăng ký, xác nhận email và đăng nhập bằng hai tài khoản thật ở Supabase thử; các phép tải ảnh, video và URL có chữ ký thực tế; làm mới trang trong khi worker đang chạy.
- Tạo và ghép video bằng các khách hàng thực tế đồng thời, một job thành công và một job lỗi, và xác nhận video trả về đúng người dùng qua ứng dụng đầy đủ.
- Mode 5 giây đã qua một lượt thử trực tiếp Muse nhưng chưa được nghiệm thu qua toàn bộ ứng dụng. Lần thử 8 giây trước đó trả về 10 giây nên không bật mode này; không tự thay bằng mode khác.
- Ước tính và nhận dạng giọng nói là kiểm tra xác suất: phát âm, âm nhạc và chất lượng mô hình có thể gây nhận dạng sai. Cần nghe đối chiếu thêm khi nghiệm thu.
- Tách cuộc trò chuyện và kiểm tra trích dẫn không chứng minh Muse không sử dụng ký ức chung của tài khoản. Không thể bảo đảm tuyệt đối Muse không đưa dữ liệu cũ hoặc tự thêm thông tin không có trong đầu vào. Cần kiểm tra thực tế, đánh giá quyền riêng tư và chỉ đưa ra sử dụng khi chấp nhận được giới hạn này.
- Việc mở và phục hồi cuộc trò chuyện Muse phải được thử lại sau bất kỳ thay đổi giao diện. Khi không xác định được kết quả đã gửi, worker dừng thay vì tự tạo video trùng.

## Bộ nhận dạng trên máy

Worker v2 cần `faster-whisper` và mô hình tương thích trên máy; không gửi âm thanh sang API AI bên ngoài. Nếu dùng container hiện có `fb-whisper`, đặt `MUSE_ASR_BACKEND=docker` và đảm bảo container đang chạy, có thư viện và mô hình trong `/models/hub`. Bộ kiểm tra dùng CPU nên có thể mất vài phút mỗi file. Phải kiểm tra môi trường trước khi kích hoạt worker v2; bộ cài phát hành và cấu hình trên máy người dùng chưa hoàn thiện.
