create extension if not exists pgcrypto;
create extension if not exists citext;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null,
  username citext not null unique,
  email citext not null unique,
  avatar_url text,
  auth_provider text not null default 'email',
  raw_profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists auth_provider text not null default 'email';
alter table public.profiles add column if not exists raw_profile jsonb not null default '{}'::jsonb;

create index if not exists profiles_user_id_idx on public.profiles (user_id);
create index if not exists profiles_username_idx on public.profiles (username);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  resolved_full_name text;
  resolved_username citext;
begin
  resolved_full_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(coalesce(new.email, ''), '@', 1),
    'Candidato'
  );

  resolved_username := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'username'), '')::citext,
    concat('user_', left(new.id::text, 8))::citext
  );

  insert into public.profiles (user_id, full_name, username, email, avatar_url, auth_provider, raw_profile)
  values (
    new.id,
    resolved_full_name,
    resolved_username,
    new.email::citext,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'avatar_url'), ''), nullif(trim(new.raw_user_meta_data ->> 'picture'), '')),
    coalesce(nullif(trim(new.raw_app_meta_data ->> 'provider'), ''), 'email'),
    coalesce(new.raw_user_meta_data, '{}'::jsonb)
  )
  on conflict (user_id) do update
  set
    full_name = excluded.full_name,
    username = excluded.username,
    email = excluded.email,
    avatar_url = excluded.avatar_url,
    auth_provider = excluded.auth_provider,
    raw_profile = excluded.raw_profile,
    updated_at = timezone('utc', now());

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

insert into public.profiles (user_id, full_name, username, email, avatar_url, auth_provider, raw_profile)
select
  u.id,
  coalesce(
    nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
    split_part(coalesce(u.email, ''), '@', 1),
    'Candidato'
  ) as full_name,
  coalesce(
    nullif(trim(u.raw_user_meta_data ->> 'username'), '')::citext,
    concat('user_', left(u.id::text, 8))::citext
  ) as username,
  u.email::citext as email,
  coalesce(nullif(trim(u.raw_user_meta_data ->> 'avatar_url'), ''), nullif(trim(u.raw_user_meta_data ->> 'picture'), '')) as avatar_url,
  coalesce(nullif(trim(u.raw_app_meta_data ->> 'provider'), ''), 'email') as auth_provider,
  coalesce(u.raw_user_meta_data, '{}'::jsonb) as raw_profile
from auth.users u
on conflict (user_id) do update
set
  full_name = excluded.full_name,
  username = excluded.username,
  email = excluded.email,
  avatar_url = excluded.avatar_url,
  auth_provider = excluded.auth_provider,
  raw_profile = excluded.raw_profile,
  updated_at = timezone('utc', now());

create or replace function public.resolve_login_email(login_identifier text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_email text;
begin
  if login_identifier is null or btrim(login_identifier) = '' then
    return null;
  end if;

  select p.email::text
  into resolved_email
  from public.profiles p
  where p.username = login_identifier::citext
     or p.email = login_identifier::citext
  limit 1;

  return resolved_email;
end;
$$;

revoke all on function public.resolve_login_email(text) from public;
grant execute on function public.resolve_login_email(text) to anon, authenticated;

drop table if exists public.job_applications cascade;

create table public.job_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  application_date date not null,
  desired_position text not null,
  desired_salary text not null,
  photo_file_name text,
  photo_file_path text,
  photo_file_size bigint,
  photo_file_type text,
  full_name text not null,
  age integer,
  birth_date date,
  sex text,
  marital_status text,
  phone text,
  mobile text,
  primary_contact_address text,
  main_school_name text,
  main_school_level text,
  personal_data jsonb not null default '{}'::jsonb,
  documentation jsonb not null default '{}'::jsonb,
  habits jsonb not null default '{}'::jsonb,
  family_data jsonb not null default '{}'::jsonb,
  education_records jsonb not null default '[]'::jsonb,
  declaration_accepted boolean not null,
  status text not null default 'submitted',
  payload jsonb not null,
  submitted_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists job_applications_user_id_idx on public.job_applications (user_id);
create index if not exists job_applications_submitted_at_idx on public.job_applications (submitted_at desc);

drop trigger if exists job_applications_set_updated_at on public.job_applications;
create trigger job_applications_set_updated_at
before update on public.job_applications
for each row
execute function public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.job_applications enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
on public.profiles
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists applications_select_own on public.job_applications;
create policy applications_select_own
on public.job_applications
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists applications_insert_own on public.job_applications;
create policy applications_insert_own
on public.job_applications
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists applications_update_own on public.job_applications;
create policy applications_update_own
on public.job_applications
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'candidate-assets',
  'candidate-assets',
  false,
  5242880,
  array[
    'image/png',
    'image/jpeg',
    'image/webp'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists candidate_assets_select_own on storage.objects;
create policy candidate_assets_select_own
on storage.objects
for select
to authenticated
using (
  bucket_id = 'candidate-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists candidate_assets_insert_own on storage.objects;
create policy candidate_assets_insert_own
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'candidate-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists candidate_assets_update_own on storage.objects;
create policy candidate_assets_update_own
on storage.objects
for update
to authenticated
using (
  bucket_id = 'candidate-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'candidate-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists candidate_assets_delete_own on storage.objects;
create policy candidate_assets_delete_own
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'candidate-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
