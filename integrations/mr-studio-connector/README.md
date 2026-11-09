# Mr Studio — kết nối ChatGPT (đang xây dựng)

Đây là mã lõi thử nghiệm, CHƯA phải plugin đã cài đặt hoặc endpoint đang hoạt động.

## Đã làm
- `worker/core.mjs`: chức năng tạo yêu cầu video tự do hoặc tạo ảnh không có ảnh tham chiếu, xem lịch sử, xem trạng thái, ký liên kết tải; mọi lệnh yêu cầu Supabase client đã xác thực thay mặt thành viên và kiểm tra user_id.
- Gửi yêu cầu bằng RPC `submit_single_media_job` sẵn có, yêu cầu jobId và requestId cố định; không tự thử lại khi chưa rõ kết quả.
- `tests/core.test.mjs`: kiểm tra mô phỏng xác thực, cách ly người dùng, hết hạn và khóa chống tạo trùng.
- `worker/mcp.mjs`: bộ xử lý JSON-RPC thử nghiệm, công cụ chuẩn bị mã, gửi, xem trạng thái/lịch sử và lấy kết quả; bắt buộc có bộ xác minh thành viên do máy chủ cung cấp. Chưa được gắn vào endpoint công khai.
- `worker/link-crypto.mjs`: các thành phần PKCE, mã hóa trạng thái và phiên liên kết theo danh tính, có kiểm thử giả lập.
- `worker/link-flow.mjs`, `worker/d1-store.mjs`, `worker/session-manager.mjs`, `worker/member-context.mjs` và `worker/site.mjs`: bản chuẩn bị luồng liên kết, lưu phiên mã hóa, khóa đồng thời, làm mới phiên và định tuyến công cụ. Phụ thuộc cổng Sites riêng tư và D1 đã migrate; chưa được xuất bản hoặc kiểm thử với dịch vụ thật.
- Màn hình đồng ý cấp quyền được chuẩn bị trong PR nháp https://github.com/nhungtran68/muse/pull/16; chưa gộp vào web chính, Supabase OAuth vẫn tắt.

## Chưa xong
- Không có endpoint MCP hay plugin có thể kết nối. Không công bố mẫu `worker/index.js`.
- Chưa có OAuth liên kết ChatGPT với tài khoản Mr Studio. Metadata Supabase OAuth hiện trả 404; OAuth server chưa được bật.
- OAuth server đã được kiểm tra tại dự án chính và đang tắt. Màn hình đồng thuận đã có bản thử nhưng chưa cài đặt ở production.
- Site riêng đã được tìm lại; kết nối hoàn chỉnh vẫn cần client OAuth và xác minh bằng dịch vụ thật.
- Chưa hỗ trợ ảnh tham chiếu, video 10 giây hoặc thực thi/tải kết quả thật. Xử lý làm mới phiên đã được chuẩn bị và kiểm thử giả lập nhưng chưa kiểm chứng với dịch vụ thật.
- Chưa có kiểm thử tích hợp thật, chưa xác minh bảo mật end-to-end.

## An toàn trước triển khai
- Phải xác minh danh tính ChatGPT và tài khoản Supabase bằng OAuth 2.1 với sự chấp thuận của người dùng; không tin cậy email hoặc ID do tool gọi truyền vào.
- Không đưa mật khẩu/token vào nội dung chat hoặc tham số tool. Không dùng service-role key cho việc thay mặt người dùng.
- Cho từng userId dùng RLS; xác thực ký link, quyền sở hữu, thời hạn; bảo vệ các yêu cầu đồng thời, không tạo trùng khi thời gian chờ không xác định.
- Phải kiểm thử upload ảnh, 10 giây, tài khoản khác, hàng đợi thật, làm mới phiên và link hết hạn trước khi bật người dùng.
- `worker/site.mjs` chỉ được chạy sau cổng Sites riêng tư đã xác thực; không đưa Worker ra công khai trực tiếp vì mã phụ thuộc danh tính do cổng cung cấp. Tạo và lưu bí mật mã hóa riêng qua cấu hình an toàn, không ghi vào mã nguồn.
- Runtime cần `DB` (D1 riêng), `MR_SITE_ORIGIN` (nguồn Sites HTTPS chính xác), `MR_OAUTH_CLIENT_ID` (public OAuth client) và `MR_LINK_KEY` (32 byte ngẫu nhiên mã hóa base64url, lưu dưới dạng secret). Đăng ký callback chính xác `<MR_SITE_ORIGIN>/link/callback`; không bật đăng ký client động đại trà. D1 phải được migrate theo cơ chế Sites trước khi chạy.
- Phạm vi OAuth `email` chỉ giới hạn thông tin nhận dạng; access token vẫn có quyền dữ liệu của thành viên theo RLS. Phải rà soát chính sách theo `client_id`, minh bạch quyền và cho phép thu hồi trước khi dùng thật. Không coi scope `email` là chỉ đọc.
- Mã hóa không thay thế cơ chế thu hồi: đã chuẩn bị giao diện/nghiệp vụ ngắt liên kết và gọi thu hồi grant; cần kiểm chứng trên dịch vụ thật. Không tự kết nối bằng token có sẵn hay dùng danh tính ChatGPT suy ra từ email.

Chạy thử mô phỏng: `node --test tests/*.test.mjs`.
