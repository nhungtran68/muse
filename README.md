# Muse Studio

Web cho thành viên tạo video thương hiệu từ **ảnh tham chiếu + nội dung + số cảnh**. Muse phân tích thành từng cảnh, worker trên máy quản trị tạo MP4 cho từng cảnh rồi FFmpeg ghép thành một MP4. Các công cụ khác được bố trí trong lưới 4 ô trên màn hình rộng và sẽ được triển khai ở các phiên bản sau.

## Kiến trúc

- **Vercel:** giao diện Vite tĩnh. Không giữ mật khẩu hoặc phiên Muse.
- **Supabase:** đăng nhập, quyền quản trị/thành viên, hàng đợi, ảnh tham chiếu và MP4 trong kho riêng. RLS giới hạn thành viên xem dữ liệu của mình.
- **Worker Windows:** chạy trên máy có phiên Muse đã đăng nhập; điều khiển giao diện muse.ai bằng Playwright. Chỉ tài khoản quản trị web mới có thể chạy worker. FFmpeg/ffprobe kiểm tra và ghép video.
- Không dùng API chính thức của Muse. Đây là tự động hóa giao diện; Muse có thể thay đổi giao diện hoặc quyền sử dụng. Kiểm tra [điều khoản Muse](https://muse.ai/terms) trước khi cung cấp dịch vụ cho khách hàng.

## Trạng thái triển khai

Bản worker **1.5.2** đã được kiểm tra thực tế ngày **03/11/2026** với ảnh tham chiếu, ba cảnh dọc 9:16, mỗi cảnh 10 giây. Lượt đang lỗi được tiếp tục từ MP4 đã tải; một lượt mới được gửi qua giao diện web, Muse chia cảnh, tạo đủ ba MP4 riêng, FFmpeg ghép thành video 30.042667 giây và video đã phát đến cuối trên web. Kiểm tra mã băm xác nhận ba cảnh là ba tệp khác nhau.

Lỗi đóng xem trước được tái hiện: nút Close biến mất sau Escape trong lúc Playwright đang chờ bấm. Worker chờ phần xem trước đóng xong trước khi dùng nút dự phòng. Có kiểm tra hồi quy cho tình huống này và việc lịch sử Muse thay đổi số lượng thẻ video.

Chạy `npm test` trong thư mục `worker` sau khi cài thư viện để chạy bộ kiểm tra. Thử nghiệm thực tế trên đây áp dụng cho ba cảnh, 10 giây/cảnh; không chứng minh mọi cấu hình hoặc mọi thay đổi giao diện Muse trong tương lai.

## Thiết lập quản trị

1. Vào web, đăng ký email `daitaigroup@gmail.com` và xác nhận email nếu Supabase gửi thư.
2. Đăng nhập, nhập mã thiết lập một lần do người vận hành dự án cung cấp. Không đưa mã này vào GitHub.
3. Duyệt tài khoản thành viên ở mục **Quản trị**. Thành viên có thể đăng ký nhưng không thể tạo video trước khi được duyệt.
4. Đặt số cảnh tối đa, lượt/ngày, thời lượng mỗi cảnh. Giữ **Nhận yêu cầu mới** tắt cho đến khi worker chạy ổn định.

## Chạy worker trên Windows

1. Cài Node.js 22+ và FFmpeg (cả `ffmpeg` và `ffprobe` phải có trong PATH).
2. Trong thư mục `worker`, chạy `01-CAI-DAT.cmd` rồi `02-CHAY-WORKER.cmd`.
3. Tự nhập email và mật khẩu quản trị web trong cửa sổ lệnh. Mật khẩu không hiển thị và không được lưu; phiên đăng nhập được lưu trong `worker/data/auth.json` trên máy.
4. Cửa sổ Chromium mở muse.ai. Tự đăng nhập tài khoản Muse hiện tại. Giữ cả hai cửa sổ mở.
5. Khi worker báo sẵn sàng, tạo thử một yêu cầu 1 cảnh trước, rồi nhiều cảnh. Chỉ sau khi nhận được MP4 đúng mới bật nhận yêu cầu cho thành viên.

Worker dùng `worker/data/muse-profile` riêng. Có thể đăng nhập Muse lại trong cửa sổ mới, không cần sao chép phiên cũ. **Không đẩy thư mục `worker/data` hoặc file phiên đăng nhập lên GitHub.** Một worker chạy tại một thời điểm. Nếu Muse trả lời mơ hồ, sai thời lượng hoặc worker khởi động lại giữa chừng, tác vụ chuyển sang **Cần kiểm tra** và chặn hàng đợi cho đến khi quản trị viên kiểm tra.

## Phát triển web

```text
npm install
npm run dev
npm run build
```

Dự án Supabase: `wqfzfduccteuycfrymbu`. Khóa trong `src/config.js` và `worker/config.js` là **publishable key**, dùng với RLS; không đặt service role key trong repo. Migration nằm ở `supabase/migrations`. Vercel được cấu hình build Vite ra `dist`.

## Giới hạn hiện tại

- Chỉ module **Tạo thương hiệu** hoạt động; ba ô còn lại là vị trí cho chức năng tiếp theo.
- Chỉ ảnh JPG, PNG, WebP tối đa 10 MB; 1–8 cảnh, 5 hoặc 10 giây/cảnh, khổ dọc 9:16. 10 giây đã được xác minh ở cầu nối cũ; luồng ảnh tham chiếu và 5 giây chưa xác minh.
- Một tài khoản Muse hiện tại xử lý mọi yêu cầu. Muse có thể giữ lịch sử và ngữ cảnh giữa khách; chưa xác minh cách ly hoàn toàn. Chỉ thử nội dung không nhạy cảm cho đến khi vấn đề này được giải quyết.
- Số cảnh và số lượt/ngày do quản trị viên đặt. Chưa có tính phí, email thông báo, hủy tác vụ đang chạy hoặc tự phục hồi tác vụ Muse không rõ kết quả.
