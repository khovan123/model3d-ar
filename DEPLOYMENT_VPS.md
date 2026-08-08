# Deploy model3d-ar on VPS

Tài liệu này ghi đúng quy trình hiện tại của dự án khi chạy trên VPS bằng `Next.js standalone`, `PM2`, và `Caddy`.

## Yêu cầu trước khi chạy

- Source code nằm tại `/home/model3d_ar/model3d-ar`
- Domain public đã trỏ về VPS
- `Caddy` đang reverse proxy về `127.0.0.1:3000`
- File `.env.local` đã có trong thư mục project
- Supabase đã chạy migration mới nhất trong `supabase/schema.sql`

## Cài công cụ chuyển đổi USDZ

Animation trên iPhone Quick Look dùng worker riêng để chuyển GLB thành USDZ. VPS
cần có Blender CLI và bộ OpenUSD chứa `usdzip`/`usdcat`.

Trên Ubuntu, kiểm tra trước xem distribution có package `usd-core` hay không:

```bash
sudo apt update
sudo apt install -y software-properties-common
sudo add-apt-repository -y universe
sudo apt update
apt-cache policy usd-core
```

Ubuntu 24.04 Noble hiện không cung cấp `usd-core`. Với Noble, build bản core của
OpenUSD từ source; tắt imaging, usdview và tài liệu để giảm thời gian/RAM:

```bash
sudo apt install -y \
  build-essential \
  cmake \
  ninja-build \
  git \
  python3 \
  python3-dev \
  libboost-all-dev \
  libtbb-dev

sudo apt install -y unzip

cd /tmp
git clone --depth 1 --branch v25.05 \
  https://github.com/PixarAnimationStudios/OpenUSD.git

sudo mkdir -p /opt/openusd
sudo chown "$USER":"$USER" /opt/openusd

python3 OpenUSD/build_scripts/build_usd.py \
  --jobs 2 \
  --no-tests \
  --no-examples \
  --no-tutorials \
  --no-docs \
  --no-usdview \
  --no-imaging \
  --no-materialx \
  /opt/openusd
```

Đăng ký thư viện và kiểm tra các tool vừa build:

```bash
echo '/opt/openusd/lib' | sudo tee /etc/ld.so.conf.d/openusd.conf
sudo ldconfig

/opt/openusd/bin/usdzip --help
PYTHONPATH=/opt/openusd/lib/python /opt/openusd/bin/usdcat --help
```

Nếu VPS ít hơn 4 GB RAM, giảm thành `--jobs 1` để tránh quá bộ nhớ trong lúc
compile. `--no-materialx` là cần thiết cho worker core-only và tránh kéo theo bộ
X11 development chỉ dùng cho MaterialX renderer.

Nên cài Blender bản mới qua Snap. Blender trong repository `apt` của một số bản
Ubuntu khá cũ và có thể chưa export đầy đủ armature animation sang USD:

```bash
sudo apt install -y \
  snapd \
  libxrender1 \
  libxi6 \
  libxfixes3 \
  libxkbcommon0 \
  libsm6 \
  libice6 \
  libgl1 \
  libegl1
sudo snap install blender --classic
sudo snap refresh blender
```

Sau khi cài, xác nhận đường dẫn và phiên bản:

```bash
command -v blender
command -v usdzip
command -v usdcat

/snap/bin/blender --version
usdzip --help
usdcat --help
```

Kiểm tra Blender ở chế độ headless, đây mới là chế độ worker thực sự sử dụng:

```bash
/snap/bin/blender --background --factory-startup \
  --python-expr "import bpy; print('BLENDER_HEADLESS_OK', bpy.app.version_string)"
```

Nếu distribution khác có package `usd-core`, có thể cài và kiểm tra bằng:

```bash
apt-cache policy usd-core
sudo apt install -y usd-core
dpkg -L usd-core 2>/dev/null | grep -E '/(usdzip|usdcat)$' || true
```

Chỉ đặt `USDZIP_BIN=/usr/bin/usdzip` và `USDCAT_BIN=/usr/bin/usdcat` sau khi
`command -v` xác nhận hai đường dẫn này thực sự tồn tại.

`usdcat` là tùy chọn nhưng nên có để worker kiểm tra `SkelRoot`/`SkelAnimation`.
Với Ubuntu 24.04 và OpenUSD được build trong `/opt/openusd`, cấu hình `.env.local`:

```env
BLENDER_BIN=/snap/bin/blender
UNZIP_BIN=/usr/bin/unzip
USDZIP_BIN=/opt/openusd/bin/usdzip
USDCAT_BIN=/opt/openusd/bin/usdcat
PYTHONPATH=/opt/openusd/lib/python
LD_LIBRARY_PATH=/opt/openusd/lib
MODEL_PACKAGE_MAX_UNCOMPRESSED_MB=500
```

Nếu VPS không dùng được Snap, có thể cài Blender từ `apt`:

```bash
sudo apt install -y blender
blender --version
```

Tuy nhiên chỉ nên dùng cách này khi phiên bản Blender đủ mới và
`npm run worker:usdz:check` báo thành công.

Không deploy code ứng dụng trước khi chạy migration, vì bản code mới đọc các cột
`asset_*` và `usdz_*` ngay khi lấy danh sách model.

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

pm2 start scripts/usdz-worker.mjs \
  --name model3d-usdz-worker \
  --cwd /home/model3d_ar/model3d-ar \
  --interpreter node \
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
pm2 restart model3d-usdz-worker --update-env
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
pm2 restart model3d-usdz-worker --update-env
```

## Kiểm tra nhanh

```bash
pm2 status
pm2 logs model3d-ar --lines 50
pm2 logs model3d-usdz-worker --lines 100
curl -I http://127.0.0.1:3000
curl -I https://model3d-ar.fogewise.io.vn
```

Trước khi bật worker liên tục, kiểm tra môi trường và chạy thử một job:

```bash
npm run worker:usdz:check
npm run worker:usdz:once
npm run worker:usdz:once
```

Với file không phải GLB, lần `--once` đầu chạy phase source -> GLB và tạo
`converted/{modelId}.glb`; lần thứ hai kiểm tra animation rồi tạo USDZ hoặc đánh
dấu `skipped`. Khi chạy PM2 liên tục, worker tự nối hai phase, không cần chạy tay
hai lần. Với model animated, Supabase phải có `usdz/{modelId}.usdz` và record
phải chuyển sang `usdz_status = 'ready'`. Kiểm tra animation cuối cùng trên
iPhone thật ở cả tab Object và AR của Quick Look.

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
- Worker chạy từ source project, không chạy từ `.next/standalone`, vì nó cần
  `scripts/blender/source_to_glb.py` và `scripts/blender/glb_to_usd.py`
