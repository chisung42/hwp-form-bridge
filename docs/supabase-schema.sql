-- Supabase schema for the HWP form bridge MVP.
-- Run this in Supabase SQL Editor, then create a private Storage bucket named
-- `form-documents` unless you set SUPABASE_STORAGE_BUCKET to another name.

create table if not exists public.forms (
  id text primary key,
  title text not null,
  source_name text,
  fields jsonb not null default '[]'::jsonb,
  page_count integer not null default 0,
  source_file_path text,
  source_file_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.form_responses (
  id text primary key,
  form_id text not null references public.forms(id) on delete cascade,
  values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists form_responses_form_id_created_at_idx
  on public.form_responses (form_id, created_at desc);

-- The current Express server uses SUPABASE_SERVICE_ROLE_KEY, so RLS policies are
-- not required for the server path. Keep direct client access locked down.
alter table public.forms enable row level security;
alter table public.form_responses enable row level security;

insert into storage.buckets (id, name, public)
values ('form-documents', 'form-documents', false)
on conflict (id) do update set public = excluded.public;
