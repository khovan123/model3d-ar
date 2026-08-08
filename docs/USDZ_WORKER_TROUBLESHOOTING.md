# USDZ worker troubleshooting notes

Tai lieu nay ghi lai cac van de thuc te da gap khi trien khai pipeline chuyen
GLB animated sang USDZ cho iPhone Quick Look, kem cach chan doan va cach fix.

## Tom tat pipeline

Worker `scripts/usdz-worker.mjs` xu ly hai phase. Phase 1 claim model co:

```text
storage_provider = supabase
asset_status = pending
asset_attempts < USDZ_MAX_ATTEMPTS
```

Blender import file nguon, export `converted/{id}.glb`, sau do set
`asset_status=ready`. Phase 2 moi claim model co:

```text
storage_provider = supabase
usdz_status = pending
asset_status = ready
usdz_attempts < USDZ_MAX_ATTEMPTS
```

Moi job di qua cac buoc:

1. Download `asset_storage_path` (GLB goc hoac GLB da convert) ve thu muc tam.
2. Doc GLB JSON chunk bang `scripts/glb-inspector.mjs`.
3. Neu khong co `animations[].channels`, set `usdz_status = skipped` va dung.
4. Neu co animation, chay Blender headless de export `model.usdc`.
5. Dong goi bang OpenUSD `usdzip --arkitAsset`.
6. Audit USD bang `usdcat` de tim `SkelRoot`, `Skeleton`, `SkelAnimation`, `SkelBindingAPI`.
7. Upload `usdz/{id}.usdz` va set `usdz_status = ready`.

## Case 0: Format nguon convert GLB that bai

Kiem tra `asset_error` va log co prefix `asset conversion failed`. Cac nguyen
nhan pho bien:

- Blender build khong co importer cho extension do, dac biet `.3mf`.
- `.gltf` thieu `.bin`/texture, hoac `.obj` thieu `.mtl`/texture.
- File bi hong, ma hoa theo version importer khong doc duoc.
- GLB dau ra vuot `MODEL_ASSET_MAX_FILE_SIZE_MB`.

Kiem tra importer cua Blender VPS:

```bash
/snap/bin/blender --background --factory-startup --python-expr \
  "import bpy; print('fbx', hasattr(bpy.ops.import_scene, 'fbx')); print('obj', hasattr(bpy.ops.wm, 'obj_import')); print('dae', hasattr(bpy.ops.wm, 'collada_import')); print('stl', hasattr(bpy.ops.wm, 'stl_import')); print('ply', hasattr(bpy.ops.wm, 'ply_import')); print('usd', hasattr(bpy.ops.wm, 'usd_import'))"
```

Sau khi sua dependency/importer, bam `Chay lai GLB` trong Studio. Retry GLB cung
reset phase USDZ de pipeline chay lai tu dau.

## Case 1: Animated GLB convert thanh cong nhung audit bao missing skeleton

### Trieu chung

Worker log Blender doc duoc animation:

```text
glb.hasAnimations = true
animationClips = 22
animationChannels = 207
skins = 1
armatures = 1
deformBones = 48
actions = 22
nlaTracks = 22
```

Nhung job fail voi loi tuong tu:

```text
USD output is missing a complete Skeleton/SkelAnimation binding:
{"skeletonAudit":"missing","markers":{"skelRoot":false,"skeleton":false,"skelAnimation":false,"skelBindingApi":false}}
```

### Buoc chan doan

Bat giu thu muc tam khi fail:

```env
USDZ_KEEP_FAILED_WORK_DIR=true
```

Chay mot job:

```bash
npm run worker:usdz:once
```

Neu worker log co `tempDir`, chuyen `model.usdc` sang USDA de grep:

```bash
DIR=/tmp/modelspace-usdz-xxxxxx

/opt/openusd/bin/usdcat "$DIR/usd/model.usdc" > "$DIR/usd/model.usda"

grep -niE 'Skel|Skeleton|SkelAnimation|animationSource|skel:skeleton|joints|Armature|Bone' \
  "$DIR/usd/model.usda" \
  | head -150
```

Voi file `Blue Iris Flower`, output thuc te co cac marker sau:

```text
def SkelRoot "Anim_blye"
def Skeleton "Anim_blye"
rel skel:animationSource = </root/ModelSpaceRoot/Anim_blye/Anim_blye/Anim_Blye>
def SkelAnimation "Anim_Blye"
prepend apiSchemas = ["MaterialBindingAPI", "SkelBindingAPI"]
rel skel:skeleton = </root/ModelSpaceRoot/Anim_blye/Anim_blye>
```

Nhu vay Blender va USD export khong sai; audit cua worker moi la noi sai.

### Nguyen nhan

Ham `runCommand()` ban dau chi giu 40KB cuoi cua stdout:

```js
const append = (current, chunk) => `${current}${chunk}`.slice(-40000);
```

`usdcat` xuat USDA rat lon. Cac marker `SkelRoot`, `Skeleton`, `SkelAnimation`
nam o phan dau file, nhung stdout bi cat mat phan dau nen audit doc khong thay va
bao `missing`.

### Cach fix

Cap nhat `runCommand()` de van giu tail mac dinh cho log loi, nhung cho phep mot
so command giu phan dau output:

```js
const maxOutputLength = options.maxOutputLength ?? 40000;
const append = (current, chunk) => {
  const next = `${current}${chunk}`;
  if (maxOutputLength === 0) return next;
  return options.keepOutputStart
    ? next.slice(0, maxOutputLength)
    : next.slice(-maxOutputLength);
};
```

Rieng audit `usdcat`, giu 2MB dau:

```js
const output = await runCommand(usdcatBin, [rootLayerPath], {
  keepOutputStart: true,
  maxOutputLength: 2 * 1024 * 1024
});
```

Sau fix, worker log dung:

```text
Conversion completed.
audit.skeletonAudit = found
markers.skelRoot = true
markers.skeleton = true
markers.skelAnimation = true
markers.skelBindingApi = true
```

## Case 2: Static model khong chuyen sang skipped

### Trieu chung

Worker detect model khong co animation va co gang set `skipped`, nhung fail:

```text
Supabase Database 400:
new row for relation "models" violates check constraint "models_usdz_status_check"
```

Trong `details` co row dang cap nhat thanh:

```text
usdz_status = skipped
```

### Nguyen nhan

Code da them status `skipped`, nhung constraint trong database Supabase chua duoc
migrate. PostgreSQL van chi cho phep cac status cu.

### Cach fix

Chay SQL migration trong Supabase SQL Editor:

```sql
alter table public.models drop constraint if exists models_usdz_status_check;

alter table public.models
  add constraint models_usdz_status_check
  check (usdz_status in ('pending', 'processing', 'ready', 'failed', 'skipped', 'unsupported'));
```

Reset job da bi loi de worker xu ly lai:

```sql
update public.models
set
  usdz_status = 'pending',
  usdz_error = null,
  usdz_attempts = 0,
  usdz_updated_at = now()
where id = 'MODEL_ID_HERE';
```

Chay lai:

```bash
npm run worker:usdz:once
```

Ket qua mong doi:

```text
Skipped USDZ conversion because the GLB has no animation channels.
```

Va trong DB:

```text
usdz_status = skipped
usdz_storage_path = null
usdz_error = null
```

## Giai thich: tai sao model static khong skipped ngay khi upload?

Khi tao model moi, record duoc set `usdz_status = pending` cho tat ca model
Supabase. Viec doc GLB de biet co animation hay khong duoc dat trong worker de
tranh lam request upload nang hon.

Do do model static chi chuyen sang `skipped` sau khi worker pick job len va chay
`glb-inspector.mjs`.

Neu muon xu ly het queue, chay worker lien tuc:

```bash
npm run worker:usdz
```

Hoac bat PM2:

```bash
pm2 start npm --name model3d-usdz-worker -- run worker:usdz
pm2 save
```

## Case 3: Model mo bang Quick Look bi nho hon mong doi

### Trieu chung

Model nhin vua binh thuong trong web/object viewer, nhung khi mo file USDZ tren
iPhone Quick Look thi kich thuoc rat nho.

### Nguyen nhan hay gap

Web viewer va Quick Look khong dung cung he quy chieu kich thuoc:

- Web viewer normalize model de vua khung camera, nen model nao cung nhin vua man
  hinh.
- USDZ/Quick Look dung kich thuoc theo met that trong khong gian AR.

Worker Blender dang scale canh lon nhat cua model ve `USDZ_TARGET_SIZE_METERS`:

```py
scale = target_size / largest
root.scale = (scale, scale, scale)
```

Neu `.env.local` de:

```env
USDZ_TARGET_SIZE_METERS=0.32
```

thi canh lon nhat cua model chi con 32cm trong AR. Voi model goc co `sourceSize`
khoang 2m, log se co dang:

```json
"normalization":{"sourceSize":[1.9,2.0,2.0],"targetSizeMeters":0.32,"scale":0.16}
```

### Cach kiem chung

Xem log worker lan convert gan nhat. Truong `normalization.targetSizeMeters` moi
la kich thuoc worker da bake vao USDZ:

```bash
pm2 logs model3d-usdz-worker --lines 120
```

Neu can inspect file USDZ da giu lai khi debug:

```bash
DIR=/tmp/modelspace-usdz-xxxxxx
/opt/openusd/bin/usdcat "$DIR/usd/model.usdc" > "$DIR/usd/model.usda"
grep -niE 'ModelSpaceRoot|xformOp:scale|metersPerUnit' "$DIR/usd/model.usda" | head -80
```

Neu da doi `USDZ_TARGET_SIZE_METERS` nhung iPhone van thay nho, hay kiem tra hai
viec:

1. Da restart worker de nap env moi chua:

   ```bash
   pm2 restart model3d-usdz-worker --update-env
   ```

2. Da reset job ve `pending` va convert lai chua. File USDZ cu khong tu doi size.

### Cach fix

Tang kich thuoc target, vi du:

```env
USDZ_TARGET_SIZE_METERS=0.8
```

Hoac:

```env
USDZ_TARGET_SIZE_METERS=1
```

Sau do restart worker, reset job va convert lai:

```sql
update public.models
set
  usdz_status = 'pending',
  usdz_storage_path = null,
  usdz_error = null,
  usdz_attempts = 0,
  usdz_updated_at = now()
where id = 'MODEL_ID_HERE';
```

```bash
npm run worker:usdz:once
```

Luu y: URL USDZ nen co version query theo `usdz_updated_at` va route redirect nen
dung `Cache-Control: no-store`. Neu URL khong doi, Safari/Quick Look co the tiep
tuc mo ban USDZ cu da cache.

## Case 4: Model co animation nhung khong co SkelAnimation

### Trieu chung

Worker fail voi loi:

```text
USD output is missing a complete Skeleton/SkelAnimation binding
```

Nhung model khong phai nhan vat/rigged mesh, vi du globe xoay, hologram loop,
logo bay, vat the rotate/translate.

### Nguyen nhan

Khong phai animation nao trong GLB cung la skeletal animation:

- Skeletal animation: GLB co `skins > 0`, USD can `SkelRoot`, `Skeleton`,
  `SkelAnimation`, `SkelBindingAPI`.
- Transform animation: GLB animate node/object rotation, translation hoac scale.
  USD co the dung `timeSamples`, khong bat buoc co `SkelAnimation`.

Audit cu da ap dung dieu kien skeletal cho moi GLB co animation, nen model
transform-only bi fail sai.

### Cach fix

Audit can dua vao metadata GLB:

```text
skins > 0  -> require SkelAnimation
skins = 0  -> accept timeSamples or SkelAnimation
```

Khi debug, xem log `glb.skins`:

```text
"glb":{"hasAnimations":true,"animationClips":...,"animationChannels":...,"skins":0}
```

Neu `skins = 0`, USD khong co `SkelAnimation` la binh thuong. Kiem tra USDA:

```bash
DIR=/tmp/modelspace-usdz-xxxxxx
/opt/openusd/bin/usdcat "$DIR/usd/model.usdc" > "$DIR/usd/model.usda"
grep -niE 'timeSamples|xformOp|SkelAnimation|SkelRoot' "$DIR/usd/model.usda" | head -120
```

Ket qua tot cho transform animation la co `timeSamples`.

## Lenh kiem tra moi truong

Truoc khi test conversion tren VPS:

```bash
cd ~/model3d-ar
npm run worker:usdz:check
```

Ky vong:

```text
blender = ok
usdzip = ok
usdcat = ok
```

Voi OpenUSD build tu source tai `/opt/openusd`, `.env.local` nen co:

```env
BLENDER_BIN=/snap/bin/blender
USDZIP_BIN=/opt/openusd/bin/usdzip
USDCAT_BIN=/opt/openusd/bin/usdcat
PYTHONPATH=/opt/openusd/lib/python
LD_LIBRARY_PATH=/opt/openusd/lib
```

Luu y: `usdzip` build tu OpenUSD source co the khong ho tro `--version`; dung
`--help` de probe.

## Khi nao nen giu USDZ_KEEP_FAILED_WORK_DIR?

Khi debug:

```env
USDZ_KEEP_FAILED_WORK_DIR=true
```

Khi chay production lau dai:

```env
USDZ_KEEP_FAILED_WORK_DIR=false
```

Neu de `true`, moi job fail se giu lai GLB/USD/USDZ trong `/tmp`. Model lon co
the lam day disk VPS.

Sau khi doi `.env.local`, restart worker:

```bash
pm2 restart model3d-usdz-worker --update-env
pm2 save
```

## Checklist test sau khi deploy fix

1. Chay migration `models_usdz_status_check` co `skipped`.
2. Chay `npm run worker:usdz:check`.
3. Reset mot animated model ve `pending`, chay `npm run worker:usdz:once`.
4. Xac nhan log co `Conversion completed` va `skeletonAudit: found`.
5. Reset mot static model ve `pending`, chay `npm run worker:usdz:once`.
6. Xac nhan log co `Skipped USDZ conversion...`.
7. Test iPhone: animated model `ready` phai dung USDZ generated.
8. Khi on dinh, dat `USDZ_KEEP_FAILED_WORK_DIR=false` va chay PM2 worker nen.

## Cau query huu ich

Danh sach job dang cho:

```sql
select id, name, storage_provider, usdz_status, usdz_attempts, usdz_error
from public.models
where usdz_status = 'pending'
order by created_at asc;
```

Kiem tra model animated da ready:

```sql
select id, name, usdz_status, usdz_storage_path, usdz_error, usdz_attempts
from public.models
where id = 'MODEL_ID_HERE';
```

Danh sach static model da skipped:

```sql
select id, name, usdz_status, usdz_storage_path, usdz_error
from public.models
where usdz_status = 'skipped';
```

Reset job de test lai:

```sql
update public.models
set
  usdz_status = 'pending',
  usdz_storage_path = null,
  usdz_error = null,
  usdz_attempts = 0,
  usdz_updated_at = now()
where id = 'MODEL_ID_HERE';
```
