# Animated USDZ pipeline

## Muc tieu

Tu dong chuyen model GLB co skeletal animation thanh USDZ tren worker backend de
iPhone Quick Look co the su dung file da chuyen doi san. Web viewer va Android
WebXR van dung GLB goc.

Khong sua truc tiep `node_modules/three/.../USDZExporter.js`. Exporter cua Three.js
van duoc giu lam fallback cho model chua co USDZ hoac conversion that bai.

## Gioi han ky thuat

- Three.js `USDZExporter` hien tai chi ghi animation transform cua Object3D, khong
  ghi day du skin binding/UsdSkel cho SkinnedMesh.
- Worker can Blender co kha nang import glTF va export USD animation, cung voi
  OpenUSD `usdzip` de dong goi dung chuan USDZ.
- Kha nang Quick Look phat mot rig cu the phai duoc xac nhan tren iPhone that.
  Worker audit archive va log ket qua, nhung khong thay the duoc device test.
- Conversion la tac vu CPU/RAM nang, khong chay trong request upload va khong chay
  trong browser.

## Kien truc

```text
Studio upload GLB
      |
      v
Supabase Storage: models/{id}.glb
Supabase DB: usdz_status=pending
      |
      v
PM2 worker claim job
      |
      +--> download GLB vao thu muc tam
      +--> Blender headless: GLB -> USDC + textures
      +--> usdzip: USDC package -> USDZ
      +--> audit USDZ (SkelRoot/Skeleton/SkelAnimation)
      +--> upload Storage: usdz/{id}.usdz
      +--> DB: usdz_status=ready
      |
      v
iPhone viewer dung /api/models/{id}/usdz
```

## Trang thai job

| Trang thai | Y nghia |
| --- | --- |
| `pending` | Dang cho worker |
| `processing` | Worker da claim va dang convert |
| `ready` | USDZ da upload thanh cong |
| `failed` | Conversion that bai; `usdz_error` co chi tiet |

`usdz_attempts` tang moi lan worker claim. Loi tam thoi duoc dua lai `pending`
cho den khi dat `USDZ_MAX_ATTEMPTS`; lan loi cuoi cung chuyen sang `failed`. Job
`processing` qua thoi gian stale cung duoc dua lai `pending` neu con luot thu.

## Du lieu

Bang `models` bo sung:

```sql
usdz_status text not null default 'pending'
usdz_storage_path text
usdz_error text
usdz_attempts integer not null default 0
usdz_updated_at timestamptz not null default now()
```

Storage paths:

```text
models/{id}.glb
usdz/{id}.usdz
audio/{id}
```

## Worker

Worker nam tai `scripts/usdz-worker.mjs` va Blender script nam tai
`scripts/blender/glb_to_usd.py`.

Worker chi chay mot job tai mot thoi diem. Chay mot lan:

```bash
npm run worker:usdz:once
```

Chay lien tuc:

```bash
npm run worker:usdz
```

Bien moi truong:

| Bien | Mac dinh | Mo ta |
| --- | --- | --- |
| `BLENDER_BIN` | `blender` | Duong dan Blender CLI |
| `USDZIP_BIN` | `usdzip` | Duong dan OpenUSD usdzip |
| `USDZ_WORK_DIR` | OS temp dir | Thu muc tam |
| `USDZ_POLL_INTERVAL_MS` | `15000` | Chu ky poll job |
| `USDZ_STALE_AFTER_MINUTES` | `30` | Reset job processing bi treo |
| `USDZ_MAX_ATTEMPTS` | `3` | So lan retry toi da |
| `USDZ_MAX_FILE_SIZE_MB` | `200` | Gioi han file USDZ dau ra |
| `USDZ_TARGET_SIZE_METERS` | `0.32` | Canh lon nhat cua model trong Quick Look |

Worker can cac bien Supabase server-only dang co:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET
```

## Fallback viewer

1. `usdz_status=ready`: iPhone mo file USDZ da tao san.
2. `pending/processing/failed`: iPhone dung Three.js USDZ exporter hien tai.
3. Web viewer va Android WebXR luon dung GLB, khong phu thuoc worker.

Fallback dam bao worker loi khong lam viewer GLB ngung hoat dong. Tuy nhien USDZ
fallback co the mat skeletal animation nhu hanh vi hien tai.

USDZ tao san uu tien animation nen khong di qua patch Three.js dung de chen
nameplate/audio vao file export tren browser. Ten, mo ta va nut audio tren trang
viewer van hoat dong; custom-action banner Quick Look van duoc gan vao URL. Neu
can nameplate nam ben trong scene Quick Look, can bo sung buoc authoring plaque
trong Blender worker o mot giai doan rieng.

## Cac buoc deploy VPS

1. Backup database va chay migration trong `supabase/schema.sql`.
2. Cai Blender va OpenUSD, sau do kiem tra:

   ```bash
   blender --version
   usdzip --help
   ```

3. Build/deploy Next.js nhu `DEPLOYMENT_VPS.md`.
4. Nap `.env.local`, chay worker mot lan voi model test.
5. Xac nhan Storage co `usdz/{id}.usdz` va DB co `usdz_status=ready`.
6. Mo file tren iPhone Quick Look, kiem tra ca tab AR va Object.
7. Chay worker lien tuc bang PM2 va `pm2 save`.

## PM2

```bash
cd /home/model3d_ar/model3d-ar
set -a
source .env.local
set +a

pm2 start scripts/usdz-worker.mjs \
  --name model3d-usdz-worker \
  --cwd /home/model3d_ar/model3d-ar \
  --interpreter node \
  --update-env

pm2 save
```

Theo doi:

```bash
pm2 logs model3d-usdz-worker --lines 100
pm2 restart model3d-usdz-worker --update-env
```

## Rollback

- Dung worker: `pm2 stop model3d-usdz-worker`.
- Viewer tu dong fallback neu record khong `ready`.
- Khong xoa GLB goc khi conversion that bai.
- Co the dat lai job bang cach cap nhat `usdz_status='pending'`, xoa
  `usdz_error`, roi khoi dong worker.

## Tieu chi hoan thanh

- Upload GLB tao record `pending`.
- Worker claim job, convert, audit, upload va chuyen sang `ready`.
- API USDZ chi tra file khi record `ready`.
- iPhone uu tien USDZ da tao san; fallback van hoat dong.
- Xoa model cung xoa `usdz/{id}.usdz`.
- Studio hien thi trang thai conversion va cho phep retry job `failed`.
- Lint/build thanh cong, worker co che do `--check` va `--once`.
