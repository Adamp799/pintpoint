create table if not exists public.pubs (
  id text primary key,
  name text not null,
  address text not null,
  description text not null,
  cheapest_pint numeric not null,
  cheapest_pint_name text not null,
  lat double precision not null,
  lng double precision not null,
  last_updated text not null
);

create table if not exists public.users (
  id text primary key,
  email text unique not null,
  username text unique not null,
  password_hash text not null,
  role text not null,
  verified boolean not null default false,
  verification_token text,
  verification_code_hash text,
  verification_expires_at bigint,
  reset_token text,
  reset_code_hash text,
  reset_expires_at bigint,
  created_at bigint not null,
  updated_at bigint not null,
  rate_limits jsonb not null default '{}'::jsonb
);

create table if not exists public.proposals (
  id text primary key,
  pub_id text not null references public.pubs(id) on delete cascade,
  pub_name text not null,
  current_pint_name text not null,
  current_pint_price numeric not null,
  proposed_pint_name text not null,
  proposed_pint_price numeric not null,
  submitted_by_user_id text not null references public.users(id) on delete cascade,
  submitted_by_username text not null,
  submitted_at bigint not null
);

create table if not exists public.audit_logs (
  id text primary key,
  action text not null,
  acted_at bigint not null,
  acted_by_user_id text not null references public.users(id) on delete cascade,
  acted_by_username text not null,
  acted_by_role text not null,
  ip text,
  proposal jsonb,
  applied_update jsonb
);

create table if not exists public.sessions (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  created_at bigint not null,
  updated_at bigint not null,
  expires_at bigint not null,
  ip text,
  user_agent text
);
