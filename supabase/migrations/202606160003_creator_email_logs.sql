create table if not exists public.creator_email_logs (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('broadcast', 'weekly_report')),
  creator_id uuid references public.creators(id) on delete set null,
  recipient_email text not null,
  subject text not null,
  period_key text,
  status text not null
    check (status in ('sent', 'failed', 'skipped')),
  error text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists creator_email_logs_creator_idx
  on public.creator_email_logs (creator_id, created_at desc);

create index if not exists creator_email_logs_kind_idx
  on public.creator_email_logs (kind, created_at desc);

create unique index if not exists creator_email_weekly_once_idx
  on public.creator_email_logs (creator_id, period_key)
  where kind = 'weekly_report' and status = 'sent' and period_key is not null;

alter table public.creator_email_logs enable row level security;

revoke all on public.creator_email_logs from anon, authenticated;
grant all privileges on table public.creator_email_logs to service_role;
