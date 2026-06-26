-- Pinboard — Supabase setup
-- Paste this whole file into: Supabase dashboard → SQL Editor → New query → Run
-- Project: worklog (same project as WorkLog itself — Pinboard is work-related, not a personal-life-log app)

create table if not exists pinboard_notes (
  id           uuid primary key default gen_random_uuid(),
  work_name    text not null,
  due_date     date,
  requested_by text,
  operator     text,
  detail       text,
  status       text not null default 'open' check (status in ('open', 'done')),
  pos_x        double precision,
  pos_y        double precision,
  locked       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Migration for a table created before pos_x/pos_y/locked existed — safe
-- to re-run, no-ops if the columns are already there.
alter table pinboard_notes add column if not exists pos_x double precision;
alter table pinboard_notes add column if not exists pos_y double precision;
alter table pinboard_notes add column if not exists locked boolean not null default false;

-- Shared team board, no per-user login — anyone with the anon key can read/write.
-- (Same trust model as WorkLog: access control is "only people who run this app
-- have the key", not per-row ownership.)
alter table pinboard_notes enable row level security;

create policy "anyone can read notes"
  on pinboard_notes for select
  using (true);

create policy "anyone can insert notes"
  on pinboard_notes for insert
  with check (true);

create policy "anyone can update notes"
  on pinboard_notes for update
  using (true);

create policy "anyone can delete notes"
  on pinboard_notes for delete
  using (true);

-- Keep updated_at current on every edit
create or replace function pinboard_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists pinboard_notes_set_updated_at on pinboard_notes;
create trigger pinboard_notes_set_updated_at
  before update on pinboard_notes
  for each row
  execute function pinboard_set_updated_at();

-- IMPORTANT — Realtime: after running this, go to
-- Database → Replication → and toggle "pinboard_notes" ON
-- so other PCs see changes live without needing to refresh.
