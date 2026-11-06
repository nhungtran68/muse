# Muse Brand Worker 3.2.0

Worker chạy trên máy quản trị viên và dùng phiên Muse trong hồ sơ Chrome riêng. Sau khi đăng nhập Windows, bộ giám sát tự mở Docker Desktop, chờ `fb-whisper`, khởi động Worker và mở lại Muse. Nếu Docker hoặc Whisper ngừng, bộ giám sát chờ và khôi phục trước khi Worker nhận tác vụ.

Phiên bản 3.2.0 hỗ trợ kho R2 riêng tư cho ảnh và video đến 100 MiB. Chỉ cập nhật Worker sau khi cơ sở dữ liệu và cổng kết nối R2 đã được triển khai; giữ nguyên thư mục phiên đăng nhập hiện có. Các tệp cũ vẫn dùng kho Supabase cũ.

## Cách dùng

1. Máy cần Node.js 22 trở lên, FFmpeg/FFprobe và Docker Desktop. Container `fb-whisper` cần có mô hình `faster-whisper-small` trong `/models/hub`.
2. Giải nén toàn bộ gói, bấm `01-CAI-DAT.cmd` một lần. Nếu chưa có phiên quản trị, bấm `03-DANG-NHAP.cmd` và nhập thông tin trực tiếp trong cửa sổ. Đăng nhập Muse trong Chrome riêng khi được yêu cầu. Bộ giám sát sẽ tự chạy từ lần đăng nhập Windows tiếp theo.
3. Dùng `02-CHAY-WORKER.cmd` nếu muốn chạy lại ngay mà không khởi động lại máy. Kiểm tra `startup-status.json` trong `%LOCALAPPDATA%\MuseBrandWorker`; trạng thái `ready` nghĩa là Worker đã nhận quyền và Muse đang sẵn sàng. Nhật ký ở `%LOCALAPPDATA%\MuseBrandWorker\logs\worker.log`.
4. Trên web, quản trị viên bật **Nhận yêu cầu mới**. Thành viên nhập một yêu cầu video, thêm một ảnh tham chiếu rồi bấm **Gửi**. Web tự chọn thời lượng Muse đang bật và đưa đúng một job với một yêu cầu video vào hàng đợi; Muse không được gọi để chia cảnh hoặc tạo kịch bản ở bước riêng.
5. Worker gửi một lần đến Muse, chờ kết quả video duy nhất, kiểm tra tệp MP4 và lưu vào job của đúng thành viên. Nếu Muse từ chối rõ ràng hoặc video hỏng, web hiện lỗi và cho gửi lại chính job đó. Nếu đã gửi nhưng kết quả chưa rõ, hệ thống giữ biên nhận và chỉ tiếp tục dò kết quả cũ để tránh tạo video trùng. Các job nhiều cảnh đã tạo trước đây tiếp tục xử lý theo kế hoạch cũ.

V3.0.9: hỗ trợ job video đơn từ giao diện mới và cập nhật trạng thái biên nhận từ “đang gửi” sang “Muse đã nhận”. Muse refusal hoặc tệp không hợp lệ được trả về web để người dùng gửi lại cùng job. Tác vụ đã gửi nhưng chưa xác nhận vẫn giữ biên nhận, không gửi trùng. Worker chờ tối đa 30 giây cho lịch sử cuộc trò chuyện tải xong trước khi kết luận chưa tìm thấy yêu cầu.

V3.0.8: khi Muse chưa hiển thị yêu cầu đã gửi, Worker đánh dấu riêng cảnh chờ kiểm tra, giữ nguyên biên nhận và không gửi lại clip. Website có nút **Tiếp tục kiểm tra Muse** để xếp lại job và dò kết quả cũ an toàn.

V3.0.7: nếu Muse quá thời hạn cho một clip, Worker ghi trạng thái lỗi, giữ biên nhận để tiếp tục lấy đúng clip đó và nhận job tiếp theo. Không tự gửi lại một yêu cầu có kết quả chưa rõ. Nếu máy chủ tạm thời không nhận được cập nhật lỗi sau ba lần thử, Worker nhả quyền xử lý để tác vụ treo được hệ thống phục hồi. Nút **Tạo lại video** trên web tiếp tục đúng job, giữ các clip đã hoàn tất.

Phiên quản trị được mã hóa bằng Windows DPAPI cho riêng người dùng Windows hiện tại; hồ sơ Chrome Muse được lưu tại `%LOCALAPPDATA%\MuseBrandWorker\muse-profile`. Không gửi hai thư mục này cho người khác. Nếu Muse hủy phiên hoặc yêu cầu xác minh lại, cần đăng nhập lại trong Chrome; phần mềm không thể tự vượt qua xác minh của Muse. Tự chạy bắt đầu sau khi người dùng đăng nhập Windows. Các job nhiều cảnh đã tạo trước đây tiếp tục dùng clip 10 giây theo từng cảnh; job mới từ giao diện một yêu cầu dùng thời lượng Muse đang bật. Prompt có thể đề nghị giữ mặt và giọng nhưng Muse không có điều khiển khóa danh tính/giọng được kiểm chứng. Kiểm tra thành phẩm trước khi dùng công khai.
