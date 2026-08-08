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
  created_at timestamptz not null default now()
);

create index if not exists models_created_at_idx on public.models (created_at desc);

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
