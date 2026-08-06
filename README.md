# Model Space — Three.js 3D QR Viewer

Website cho phép designer tải model 3D lên, tạo QR riêng và chia sẻ trang xem model trực tiếp trên điện thoại.

## Chức năng

- Designer Studio: tải file `.glb`, đặt tên, mô tả, quản lý danh sách model.
- QR code tự động: mỗi model có QR SVG và URL công khai riêng.
- Three.js viewer tối ưu mobile, tự căn giữa và scale model.
- Chế độ **Chạm**: xoay bằng một ngón, pinch để thu phóng.
- Chế độ **Chuyển động**: dùng `DeviceOrientationEvent` để đổi góc model khi di chuyển điện thoại.
- Streaming file hỗ trợ HTTP Range để tải model lớn ổn định hơn.
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
| `MAX_MODEL_SIZE_MB` | Kích thước file tối đa, mặc định 50 MB |

## Chuẩn file model

MVP nhận `.glb` vì đây là định dạng nhị phân tự chứa geometry, material và texture. Trước khi tải lên nên:

- Giảm polygon và kích thước texture cho mobile.
- Dùng texture WebP/JPEG hợp lý; tránh texture 8K nếu không cần.
- Đặt pivot/center đúng và loại bỏ object không sử dụng.
- Kiểm tra model bằng glTF Validator.

## Lưu ý triển khai

Storage hiện dùng filesystem tại thư mục `data/`. Vì vậy cần máy chủ hoặc container có persistent volume. Không nên deploy nguyên trạng lên nền tảng serverless có filesystem tạm thời. Với hệ thống production nhiều người dùng, thay storage adapter trong `lib/models.ts` bằng S3/R2 và metadata database.

Chế độ cảm biến chỉ hoạt động ổn định trên HTTPS (ngoại trừ localhost) và iOS yêu cầu người dùng cấp quyền sau một thao tác bấm.
