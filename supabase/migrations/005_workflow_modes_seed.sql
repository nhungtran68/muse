-- Data seed is separate from the additive schema migration.
insert into public.video_modes(seconds,enabled,verified_at,note) values
(10,true,now(),'Đã kiểm tra thời lượng 10 giây; lời thoại từng job được kiểm tra riêng'),
(5,true,now(),'Đã thử một video 5 giây có lời thoại; mỗi job vẫn được kiểm tra riêng'),
(8,false,null,'Không tự thay bằng video 10 giây')
on conflict(seconds) do nothing;
