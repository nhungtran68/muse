-- Data seed is separate from the additive schema migration.
insert into public.video_modes(seconds,enabled,verified_at,note) values
(10,true,now(),'Đã kiểm tra thời lượng 10 giây; lời thoại từng job được kiểm tra riêng'),
(5,false,null,'Chờ nghiệm thu lời thoại và video thực tế'),
(8,false,null,'Không tự thay bằng video 10 giây')
on conflict(seconds) do nothing;
