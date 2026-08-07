# Deploy model3d-ar on VPS

Tài liệu này ghi đúng quy trình hiện tại của dự án khi chạy trên VPS bằng `Next.js standalone`, `PM2`, và `Caddy`.

## Yêu cầu trước khi chạy

- Source code nằm tại `/home/model3d_ar/model3d-ar`
- Domain public đã trỏ về VPS
- `Caddy` đang reverse proxy về `127.0.0.1:3000`
- File `.env.local` đã có trong thư mục project

## Cấu trúc Caddy

File site riêng:

```caddyfile
model3d-ar.fogewise.io.vn {
    import fogewise_common
    reverse_proxy 127.0.0.1:3000
}
```

File chung:

```caddyfile
{
    admin 127.0.0.1:2019
}

(fogewise_common) {
    tls /etc/caddy/certs/fogewise-origin.pem /etc/caddy/certs/fogewise-origin.key
    encode zstd gzip

    header {
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
    }
}

import /etc/caddy/conf.d/*.caddy
```

## Pull code và chạy lại

```bash
cd /home/model3d_ar/model3d-ar
git pull
npm install
npm run build
```

Vì `next.config.ts` đang dùng `output: "standalone"`, cần copy static assets vào thư mục standalone trước khi chạy:

```bash
rm -rf .next/standalone/.next/static
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static

rm -rf .next/standalone/public
cp -r public .next/standalone/public 2>/dev/null || true
```

## Chạy lần đầu bằng PM2

```bash
cd /home/model3d_ar/model3d-ar

set -a
source .env.local
set +a

HOSTNAME=127.0.0.1 PORT=3000 pm2 start .next/standalone/server.js \
  --name model3d-ar \
  --cwd /home/model3d_ar/model3d-ar \
  --update-env

pm2 save
```

## Cập nhật code sau này

Khi chỉ thay đổi code ứng dụng:

```bash
cd /home/model3d_ar/model3d-ar
git pull
npm install
npm run build

rm -rf .next/standalone/.next/static
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static

rm -rf .next/standalone/public
cp -r public .next/standalone/public 2>/dev/null || true

set -a
source .env.local
set +a

pm2 restart model3d-ar --update-env
pm2 save
```

## Khi đổi env

Nếu sửa `.env.local`, chạy lại:

```bash
cd /home/model3d_ar/model3d-ar

set -a
source .env.local
set +a

pm2 restart model3d-ar --update-env
```

## Kiểm tra nhanh

```bash
pm2 status
pm2 logs model3d-ar --lines 50
curl -I http://127.0.0.1:3000
curl -I https://model3d-ar.fogewise.io.vn
```

## Nếu web lên nhưng không có CSS

Lỗi này thường do quên copy thư mục static vào standalone. Chạy lại:

```bash
rm -rf .next/standalone/.next/static
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static
pm2 restart model3d-ar --update-env
```

## Nếu đổi Caddy config

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Ghi nhớ

- Không dùng `next start` với cấu hình `output: "standalone"`
- Không đặt `SUPABASE_SERVICE_ROLE_KEY` ở phía client
- `APP_URL` phải là domain public, ví dụ `https://model3d-ar.fogewise.io.vn`
