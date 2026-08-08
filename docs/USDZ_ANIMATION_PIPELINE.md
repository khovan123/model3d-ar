# Animated USDZ pipeline

## Muc tieu

Tu dong chuan hoa moi dinh dang 3D duoc upload thanh mot GLB canonical cho web
viewer va Android WebXR, sau do dung chinh GLB canonical do de tao USDZ cho
iPhone Quick Look.

Mot invariant quan trong cua pipeline la physical scale: canh lon nhat cua model
sau phase 1 phai bang `MODEL_TARGET_SIZE_METERS` (mac dinh `0.8` met). Scale nay
duoc encode vao hierarchy GLB, khong chi ap dung tam thoi o Android hoac o buoc
USDZ. Vi vay GLB Original co authoring unit khac voi derivative cua Sketchfab van
cho cung kich thuoc khi vao AR.

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
- Canonical scale duoc dat bang mot root transform chung thay vi apply scale truc
  tiep len mesh/armature. Cach nay giu skin, inverse bind matrix va animation an
  toan hon khi re-export.

## Kien truc

```text
Studio upload GLB/FBX/OBJ/DAE/BLEND/ZIP/...
      |
      v
Supabase Storage: models/{id}.{ext}
Supabase DB: asset_status=pending
      |
      v
Phase 1 - PM2 worker claim asset job
      |
      +--> download source vao thu muc tam
      +--> neu ZIP: giai nen va chon model chinh
      +--> Blender import moi source, ke ca GLB self-contained
      +--> tinh evaluated mesh bounds tai frame dau
      +--> encode canonical root scale + meter units
      +--> export GLB: converted/{id}.glb
      +--> DB: asset_status=ready
      |
      v
Phase 2 - PM2 worker claim USDZ job
      |
      +--> download converted/{id}.glb
      +--> inspect GLB JSON chunk
      |      +--> no animation: usdz_status=skipped, stop
      |
      +--> Blender headless: GLB -> USDC + textures
      +--> giu meter units + cung MODEL_TARGET_SIZE_METERS
      +--> usdzip: USDC package -> USDZ
      +--> audit USDZ (SkelRoot/Skeleton/SkelAnimation)
      +--> upload Storage: usdz/{id}.usdz
      +--> DB: usdz_status=ready
      |
      v
Android/WebXR dung converted/{id}.glb
iPhone Quick Look dung usdz/{id}.usdz
```

## Vi sao GLB cung phai qua phase 1

Truoc day GLB self-contained duoc copy nguyen sang viewer asset. Android sau do
normalize bounding box runtime nen sai authoring unit bi che mat, trong khi Quick
Look van co the nhin thay physical scale khac nhau.

Vi du Blue Flower cua Sketchfab:

```text
Original GLB max dimension  ~0.0739 m
Sketchfab converted GLB     ~1.4774 m
Ty le                         ~20x
```

Neu copy raw GLB, hai file co scene hierarchy khac nhau truoc khi vao USDZ. Pipeline
moi bat buoc ca hai di qua `source_to_glb.py`, dua canh lon nhat ve cung target va
luu scale ngay trong GLB canonical. `glb_to_usd.py` nhan GLB da canonical nen buoc
normalize USDZ thuong co scale gan 1.0 thay vi phai sua mot authoring scale lon.

## Trang thai job

Phase GLB dung `asset_status`:

| Trang thai | Y nghia |
| --- | --- |
| `pending` | Dang cho worker import/canonicalize file nguon |
| `processing` | Blender dang import va export GLB |
| `ready` | `asset_storage_path` da co GLB canonical cho viewer |
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

`asset_attempts` va `usdz_attempts` tang moi lan worker claim. Loi tam thoi duoc
dua lai `pending` cho den khi dat `USDZ_MAX_ATTEMPTS`; lan loi cuoi cung chuyen
sang `failed`. Job `processing` qua thoi gian stale cung duoc dua lai `pending`
neu con luot thu.

## Du lieu va storage

Bang `models` su dung cac cot:

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
models/{id}.{source_ext}
converted/{id}.glb
usdz/{id}.usdz
audio/{id}
```

Model upload moi, ke ca `.glb`, se co `asset_status=pending`; viewer chi dung
`asset_storage_path` sau khi worker tao GLB canonical. Upload `.usdz` van co the
co `usdz_status=ready` ngay, nhung neu can web viewer thi source van vao phase 1.

Voi model co file phu, nen upload `.zip` giu nguyen cau truc thu muc. Worker giai
nen, tu chon model chinh va de Blender resolve `.bin`, `.mtl` va texture theo
duong dan tuong doi. ZIP co mot `.glb` goc khong con duoc copy verbatim; GLB do
cung duoc import/export de encode canonical physical scale.

Thu tu uu tien file model trong ZIP la `.glb`, `.gltf`, `.fbx`, `.blend`, `.dae`,
`.obj`, `.3mf`, `.stl`, `.ply`, `.usdz`. Neu co nhieu file cung loai, worker uu
tien file nam gan root archive, sau do uu tien file lon hon.

## Worker

Worker nam tai `scripts/usdz-worker.mjs`. Hai Blender script la:

- `scripts/blender/source_to_glb.py`: import source, tinh bounds, normalize ve
  canonical meter scale va export GLB.
- `scripts/blender/glb_to_usd.py`: chuyen GLB canonical animated sang USDC de
  dong goi USDZ, giu meter units va cung target size.

Chay mot lan:

```bash
npm run worker:usdz:once
```

Chay lien tuc:

```bash
npm run worker:usdz
```

Kiem tra dependency tren VPS:

```bash
npm run worker:usdz:check
```

Bien moi truong:

| Bien | Mac dinh | Mo ta |
| --- | --- | --- |
| `BLENDER_BIN` | `blender` | Duong dan Blender CLI |
| `UNZIP_BIN` | `unzip` | Cong cu giai nen package model |
| `USDZIP_BIN` | `usdzip` | Duong dan OpenUSD usdzip |
| `USDZ_WORK_DIR` | OS temp dir | Thu muc tam |
| `USDZ_POLL_INTERVAL_MS` | `15000` | Chu ky poll job |
| `USDZ_STALE_AFTER_MINUTES` | `30` | Reset job processing bi treo |
| `USDZ_MAX_ATTEMPTS` | `3` | So lan retry toi da |
| `USDZ_MAX_FILE_SIZE_MB` | `200` | Gioi han file USDZ dau ra |
| `MODEL_ASSET_MAX_FILE_SIZE_MB` | `250` | Gioi han GLB sau phase 1 |
| `MODEL_PACKAGE_MAX_UNCOMPRESSED_MB` | `500` | Gioi han tong dung luong ZIP sau giai nen |
| `MODEL_TARGET_SIZE_METERS` | `0.8` | Canh lon nhat cua GLB canonical va USDZ |
| `USDZ_TARGET_SIZE_METERS` | `0.8` | Fallback cu neu chua set `MODEL_TARGET_SIZE_METERS` |
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
3. Web viewer va Android WebXR dung `asset_storage_path`; moi source Supabase phai
   cho phase 1 canonicalization hoan thanh.

Fallback dam bao worker loi khong lam mat source upload. Tuy nhien USDZ fallback
co the mat skeletal animation nhu hanh vi hien tai.

## Model da upload truoc thay doi nay

Record cu co the dang `asset_status=ready` va `asset_storage_path` tro thang vao
raw GLB. Worker khong tu dong reprocess record `ready` de tranh thay doi asset dang
production.

De test/fix Blue Flower cu, cach an toan nhat la upload lai file sau khi deploy.
Neu can reprocess record cu tren database, dua `asset_status` ve `pending`, reset
`asset_attempts`, xoa `asset_storage_path` cu va dua `usdz_status` ve `pending`
truoc khi worker chay lai. Chi thuc hien sau khi da backup DB/Storage.

## Cac buoc deploy VPS

1. Backup database va Storage metadata.
2. Cai Blender va OpenUSD, sau do kiem tra `blender --version` va `usdzip --help`.
3. Dat `MODEL_TARGET_SIZE_METERS=0.8` trong `.env.local` (hoac target mong muon).
4. Build/deploy Next.js va restart worker.
5. Upload lai `blue-flower-animated.zip` Original de tao GLB canonical moi.
6. Xac nhan log phase 1 co `canonicalTargetSizeMeters` va `normalization.scale`.
7. Xac nhan Storage co `converted/{id}.glb` va `usdz/{id}.usdz` neu model animated.
8. Mo tren Android va iPhone Quick Look, so sanh kich thuoc AR va placement origin.
