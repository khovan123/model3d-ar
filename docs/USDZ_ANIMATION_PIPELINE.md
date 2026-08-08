# Animated USDZ pipeline

## Muc tieu

Tu dong chuan hoa cac dinh dang 3D duoc upload thanh GLB cho web viewer, sau do
chuyen GLB co animation thanh USDZ tren worker backend de iPhone Quick Look dung
file da chuyen doi san.

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
Studio upload GLB/FBX/OBJ/DAE/BLEND/...
      |
      v
Supabase Storage: models/{id}.{ext}
Supabase DB: asset_status=pending
      |
      v
Phase 1 - PM2 worker claim asset job
      |
      +--> download source vao thu muc tam
      +--> Blender importer theo extension
      +--> export GLB: converted/{id}.glb
      +--> DB: asset_status=ready
      |
      v
Phase 2 - PM2 worker claim USDZ job
      |
      +--> download GLB da chuan hoa
      +--> inspect GLB JSON chunk
      |      +--> no animation: usdz_status=skipped, stop
      |
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

Phase GLB dung `asset_status`:

| Trang thai | Y nghia |
| --- | --- |
| `pending` | Dang cho worker import file nguon |
| `processing` | Blender dang import va export GLB |
| `ready` | `asset_storage_path` da co GLB cho viewer |
| `failed` | Import/export that bai; `asset_error` co chi tiet |
| `unsupported` | Blender tren server khong co importer phu hop |

Phase USDZ dung `usdz_status`:

| Trang thai | Y nghia |
| --- | --- |
| `pending` | Dang cho worker |
| `processing` | Worker da claim va dang convert |
| `ready` | USDZ da upload thanh cong |
| `failed` | Conversion that bai; `usdz_error` co chi tiet |
| `skipped` | GLB khong co animation channel, khong can tao USDZ san |

`usdz_attempts` tang moi lan worker claim. Loi tam thoi duoc dua lai `pending`
cho den khi dat `USDZ_MAX_ATTEMPTS`; lan loi cuoi cung chuyen sang `failed`. Job
`processing` qua thoi gian stale cung duoc dua lai `pending` neu con luot thu.

## Du lieu

Bang `models` bo sung:

```sql
asset_status text not null default 'pending'
asset_storage_path text
asset_error text
asset_attempts integer not null default 0
asset_updated_at timestamptz not null default now()

usdz_status text not null default 'pending'
usdz_storage_path text
usdz_error text
usdz_attempts integer not null default 0
usdz_updated_at timestamptz not null default now()
```

Storage paths:

```text
models/{id}.glb
models/{id}.{source_ext}
converted/{id}.glb
usdz/{id}.usdz
audio/{id}
```

## Worker

Worker nam tai `scripts/usdz-worker.mjs`. Hai Blender script la:

- `scripts/blender/source_to_glb.py`: import file nguon va export GLB.
- `scripts/blender/glb_to_usd.py`: chuyen GLB animated sang USDC de dong goi USDZ.

Neu gap loi audit skeleton, static model khong chuyen sang `skipped`, hoac can
xem lai case thuc te da debug tren VPS, doc them
`docs/USDZ_WORKER_TROUBLESHOOTING.md`.

Truoc khi goi Blender, worker doc JSON chunk cua GLB va dem `animations[].channels`.
Neu khong co channel, job chuyen sang `skipped`; Blender, `usdzip` va upload USDZ
deu khong chay cho model do.

Studio queue `.gltf`, `.fbx`, `.obj`, `.stl`, `.dae`, `.ply`, `.3mf`, `.blend`
va `.usdz` vao phase GLB. `.glb` bo qua import vi da la asset viewer. `.usdz`
upload san duoc danh dau `usdz_status=ready`, nhung van co the vao phase GLB de
web viewer su dung.

Luu y file upload hien la mot object duy nhat. `.gltf`, `.obj` va `.dae` chi
convert duoc neu texture/buffer da embedded hoac khong can file phu. File tham
chieu `.bin`, `.mtl` hay texture ben ngoai can mot phase package ZIP rieng; worker
khong the tu tim cac dependency chua duoc upload.

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
| `MODEL_ASSET_MAX_FILE_SIZE_MB` | `250` | Gioi han GLB sau phase 1 |
| `USDZ_TARGET_SIZE_METERS` | `0.32` | Canh lon nhat cua model trong Quick Look |
| `USDZ_KEEP_FAILED_WORK_DIR` | `false` | Giu thu muc tam khi can debug conversion |

Worker can cac bien Supabase server-only dang co:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET
```

## Fallback viewer

1. `usdz_status=ready`: iPhone mo file USDZ da tao san.
2. `pending/processing/failed/skipped`: iPhone dung Three.js USDZ exporter hien tai.
3. Web viewer va Android WebXR dung `asset_storage_path`; file khong phai GLB
   phai cho phase 1 hoan thanh.

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

- Upload GLB tao `asset_status=ready`; format khac tao `asset_status=pending`.
- Format khac duoc Blender import va upload `converted/{id}.glb`.
- Model khong co animation chuyen sang `skipped` ma khong goi Blender.
- Model co animation duoc convert, audit, upload va chuyen sang `ready`.
- API USDZ chi tra file khi record `ready`.
- iPhone uu tien USDZ da tao san; fallback van hoat dong.
- Xoa model cung xoa `usdz/{id}.usdz`.
- Studio hien thi trang thai conversion va cho phep retry job `failed`.
- Lint/build thanh cong, worker co che do `--check` va `--once`.
