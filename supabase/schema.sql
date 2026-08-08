create table if not exists public.models (
  id uuid primary key,
  name text not null check (char_length(name) between 2 and 100),
  description text not null default '' check (char_length(description) <= 500),
  original_file_name text not null,
  stored_file_name text,
  storage_path text,
  storage_provider text check (storage_provider in ('local', 'supabase')),
  mime_type text not null default 'model/gltf-binary',
  size bigint not null check (size > 0),
  created_at timestamptz not null default now(),
  asset_status text not null default 'pending' check (asset_status in ('pending', 'processing', 'ready', 'failed', 'unsupported')),
  asset_storage_path text,
  asset_error text,
  asset_attempts integer not null default 0 check (asset_attempts >= 0),
  asset_updated_at timestamptz not null default now(),
  usdz_status text not null default 'pending' check (usdz_status in ('pending', 'processing', 'ready', 'failed', 'skipped', 'unsupported')),
  usdz_storage_path text,
  usdz_error text,
  usdz_attempts integer not null default 0 check (usdz_attempts >= 0),
  usdz_updated_at timestamptz not null default now()
);

alter table public.models add column if not exists asset_status text not null default 'pending';
alter table public.models add column if not exists asset_storage_path text;
alter table public.models add column if not exists asset_error text;
alter table public.models add column if not exists asset_attempts integer not null default 0;
alter table public.models add column if not exists asset_updated_at timestamptz not null default now();

alter table public.models drop constraint if exists models_asset_status_check;
alter table public.models
  add constraint models_asset_status_check
  check (asset_status in ('pending', 'processing', 'ready', 'failed', 'unsupported'));

update public.models
set
  asset_status = 'ready',
  asset_storage_path = storage_path,
  asset_error = null,
  asset_updated_at = now()
where lower(coalesce(storage_path, '')) like '%.glb'
  and asset_storage_path is null;

alter table public.models add column if not exists usdz_status text not null default 'pending';
alter table public.models add column if not exists usdz_storage_path text;
alter table public.models add column if not exists usdz_error text;
alter table public.models add column if not exists usdz_attempts integer not null default 0;
alter table public.models add column if not exists usdz_updated_at timestamptz not null default now();

alter table public.models drop constraint if exists models_usdz_status_check;
alter table public.models
  add constraint models_usdz_status_check
  check (usdz_status in ('pending', 'processing', 'ready', 'failed', 'skipped', 'unsupported'));

update public.models
set
  usdz_status = 'pending',
  usdz_error = null,
  usdz_attempts = 0,
  usdz_updated_at = now()
where usdz_status = 'unsupported'
  and coalesce(storage_path, '') ~* '\.(glb|gltf|obj|fbx|stl|dae|ply|3mf|blend)$';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'models_usdz_attempts_check'
      and conrelid = 'public.models'::regclass
  ) then
    alter table public.models
      add constraint models_usdz_attempts_check
      check (usdz_attempts >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'models_asset_attempts_check'
      and conrelid = 'public.models'::regclass
  ) then
    alter table public.models
      add constraint models_asset_attempts_check
      check (asset_attempts >= 0);
  end if;
end $$;

create index if not exists models_created_at_idx on public.models (created_at desc);
create index if not exists models_asset_queue_idx
  on public.models (asset_status, created_at)
  where storage_provider = 'supabase';
create index if not exists models_usdz_queue_idx
  on public.models (usdz_status, created_at)
  where storage_provider = 'supabase';

alter table public.models enable row level security;

-- No public policies are required. The Next.js server uses the service role key.

-- Keep the default private Storage bucket compatible with both GLB models and
-- optional model audio. Re-running this file updates an existing `models`
-- bucket without changing its current file-size limit.
insert into storage.buckets (
  id,
  name,
  public,
  allowed_mime_types
)
values (
  'models',
  'models',
  false,
  array[
    'model/gltf-binary',
    'model/gltf+json',
    'model/vnd.usdz+zip',
    'model/vnd.usd+zip',
    'model/obj',
    'model/stl',
    'model/vnd.collada+xml',
    'model/3mf',
    'application/octet-stream',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/x-m4a',
    'audio/m4a',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/ogg',
    'audio/aac',
    'audio/x-aac'
  ]::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  allowed_mime_types = excluded.allowed_mime_types;
