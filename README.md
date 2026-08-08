# Model Space — Three.js 3D QR Viewer

Website cho phép designer tải model 3D lên, tạo QR riêng và chia sẻ trang xem model trực tiếp trên điện thoại.

## Chức năng

- Designer Studio: tải file `.glb`, đặt tên, mô tả, quản lý danh sách model.
- QR code tự động: mỗi model có QR SVG và URL công khai riêng.
- Three.js viewer tối ưu mobile, tự căn giữa và scale model.
- Chế độ **Chạm**: xoay bằng một ngón, pinch để thu phóng.
- Chế độ **Chuyển động**: dùng `DeviceOrientationEvent` để đổi góc model khi di chuyển điện thoại.
- Upload trực tiếp từ trình duyệt lên Supabase Storage bằng signed URL; file lớn không đi qua Next.js.
- Viewer lấy model từ private bucket bằng signed download URL.
- Worker tự động chuyển GLB animation thành USDZ để iPhone Quick Look ưu tiên sử dụng.
- Có thể bảo vệ thao tác upload/xóa bằng `ADMIN_UPLOAD_TOKEN`.
- Docker image dạng Next.js standalone và volume lưu dữ liệu.

## Chạy local

```bash
cp .env.example .env.local
npm install
npm run dev
```

Mở `http://localhost:3000/studio` để tải model lên.

## Chạy bằng Docker

```bash
docker compose up --build -d
```

Dữ liệu được giữ trong Docker volume `modelspace_data`.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `APP_URL` | Domain công khai được ghi vào QR, ví dụ `https://3d.example.com` |
| `ADMIN_UPLOAD_TOKEN` | Mã tùy chọn để bảo vệ upload và xóa |
| `MAX_MODEL_SIZE_MB` | Kích thước file model tối đa, mặc định 50 MB |
| `MAX_AUDIO_SIZE_MB` | Kích thước file audio tối đa, mặc định 20 MB |
| `SUPABASE_URL` | Project URL, ví dụ `https://abc.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key, chỉ được đặt ở server |
| `SUPABASE_STORAGE_BUCKET` | Tên private bucket, mặc định `models` |
| `SUPABASE_DATABASE_ENABLED` | Dùng Supabase Database cho metadata, mặc định `true` |
| `BLENDER_BIN` | Đường dẫn Blender CLI, mặc định `blender` |
| `USDZIP_BIN` | Đường dẫn OpenUSD `usdzip`, mặc định `usdzip` |
| `USDCAT_BIN` | Đường dẫn `usdcat` dùng để audit skeleton, mặc định `usdcat` |
| `USDZ_POLL_INTERVAL_MS` | Chu kỳ worker tìm job mới, mặc định 15000 ms |
| `USDZ_MAX_ATTEMPTS` | Số lần chuyển đổi tối đa, mặc định 3 |
| `USDZ_TARGET_SIZE_METERS` | Kích thước vật lý cạnh lớn nhất trong Quick Look, mặc định 0.32 m |

## Cấu hình Supabase Storage

1. Tạo project tại Supabase.
2. Mở **SQL Editor** và chạy toàn bộ file `supabase/schema.sql`. File này tạo/cập nhật bảng `models` và private bucket mặc định `models` để chấp nhận GLB, USDZ và audio.
3. Bucket `models` hỗ trợ các MIME chính:
   - model: `model/gltf-binary`, `model/vnd.usdz+zip`, `model/vnd.usd+zip`, `application/octet-stream`;
   - audio: `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/wav`, `audio/x-wav`, `audio/ogg`, `audio/aac` cùng các alias tương ứng.
4. Nếu dùng tên bucket khác qua `SUPABASE_STORAGE_BUCKET`, đổi `'models'` trong phần cấu hình `storage.buckets` của `supabase/schema.sql` sang đúng tên bucket trước khi chạy.
5. Trong **Project Settings → API**, lấy Project URL và service role key rồi đặt vào `.env.local`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_STORAGE_BUCKET=models
SUPABASE_DATABASE_ENABLED=true
MAX_AUDIO_SIZE_MB=20
```

Không đặt `SUPABASE_SERVICE_ROLE_KEY` trong biến có tiền tố `NEXT_PUBLIC_` và không đưa key này vào frontend.

Luồng upload gồm ba bước: frontend xin signed upload URL từ Next.js, `PUT` file trực tiếp lên Supabase, sau đó gửi metadata nhỏ về Next.js để tạo model và QR. Audio tùy chọn dùng cùng private bucket với path `audio/{modelId}`.

## Pipeline USDZ animation

Sau khi metadata được tạo, model Supabase có trạng thái `usdz_status=pending`.
Worker đọc JSON chunk của GLB trước; model không có animation được đánh dấu
`skipped` và không tạo USDZ. Với model có animation, worker dùng Blender headless
xuất USD animation, đóng gói bằng `usdzip`, audit skeleton rồi upload vào
`usdz/{modelId}.usdz`. Studio tự cập nhật trạng thái và cho phép chạy lại job
thất bại.

```bash
npm run worker:usdz:check
npm run worker:usdz:once
npm run worker:usdz
```

iPhone ưu tiên file USDZ đã tạo khi trạng thái là `ready`. Trong lúc chờ hoặc
khi conversion lỗi, viewer vẫn dùng Three.js exporter hiện tại làm fallback,
nhưng fallback không đảm bảo skeletal animation. Thiết kế và quy trình chi tiết
nằm trong `docs/USDZ_ANIMATION_PIPELINE.md`.

## Chuẩn file model

MVP nhận `.glb` vì đây là định dạng nhị phân tự chứa geometry, material và texture. Trước khi tải lên nên:

- Giảm polygon và kích thước texture cho mobile.
- Dùng texture WebP/JPEG hợp lý; tránh texture 8K nếu không cần.
- Đặt pivot/center đúng và loại bỏ object không sử dụng.
- Kiểm tra model bằng glTF Validator.

## Lưu ý triển khai

File và metadata model mới đều được lưu trên Supabase. Ứng dụng vẫn đọc dữ liệu local cũ để không làm mất model hiện tại; có thể upload lại model cũ sau khi setup để đưa cả file và metadata lên Supabase.

Chế độ cảm biến chỉ hoạt động ổn định trên HTTPS (ngoại trừ localhost) và iOS yêu cầu người dùng cấp quyền sau một thao tác bấm.
