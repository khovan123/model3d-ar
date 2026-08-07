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
