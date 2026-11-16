# Gửi video hoàn tất tới nhóm Zalo

Chức năng này có hai công tắc chỉ quản trị viên nhìn thấy:

- Kho kết quả: `R2` hoặc `Supabase Storage`.
- Gửi video hoàn tất tới nhóm Zalo.

Khi bật gửi Zalo, hệ thống cần một `ZALO_GROUP_WEBHOOK_URL` ở môi trường worker. URL này nên trỏ tới một workflow n8n/Make hoặc endpoint Zalo Official Account/GMF đã được cấp quyền gửi tới nhóm. Token Zalo không lưu trong `app_settings` và không đưa vào trình duyệt.

Mỗi job chỉ được claim một lần cho từng nhóm; gửi trùng bị chặn trong 15 phút. Lỗi giao Zalo được ghi ở `media_deliveries` và không làm job video chuyển thành lỗi. Liên kết media có thời hạn ngắn, vì vậy bridge phải tải hoặc chuyển tiếp ngay khi nhận webhook.

Sau khi triển khai migration, quản trị viên vào mục **Quản trị → Phân phối kết quả**, chọn kho, bật gửi Zalo, nhập mã nhóm/OA target rồi lưu. Nếu chưa cấu hình webhook, video vẫn hoàn tất bình thường và trạng thái giao sẽ là chưa cấu hình.
