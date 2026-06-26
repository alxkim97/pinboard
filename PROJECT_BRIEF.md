# Post-it Notes — New Project Brief

**Purpose of this file:** paste this whole file into a new Claude Code chat to start building the app. It captures the requirements as given by Alex and the conventions this app should follow to stay consistent with his other tools. Nothing has been built yet — this is a from-scratch project.

---

## What it is

An Electron "post-it note" board for the APm R&D team. Multiple R&D personnel, on multiple PCs, need to see the same set of notes — so this is a **shared/synced board**, not a personal single-PC app.

Each note's front face (the part visible without clicking in) shows:
- **Name of work**
- **Due date**
- **Request from** (who asked for this)
- **Main operator** (who's responsible for doing it)

Clicking into a note opens the full detail (free-text description/notes, and any other fields that don't fit on the card face).

## Why a separate app from WorkLog

Alex already has **WorkLog** (`Work\worklog\`) — an Electron task tracker for the same R&D/PD team with a similar-looking task schema (title, type, due date, assignee, notes) on a Supabase backend. This new app is explicitly a separate, simpler "post-it board" concept rather than a feature added to WorkLog. Worth a sentence to Alex early in the new chat confirming that's intentional (vs. just adding a "sticky board view" to WorkLog) before investing in a full new Electron scaffold — but proceed with a standalone app per his request unless he says otherwise.

## Suggested architecture (matches Alex's existing apps — confirm before deviating)

- **Electron**, vanilla HTML/CSS/JS, single-file renderer (`index.html`) + `main.js` (IPC, Supabase client) + `preload.js` (context bridge) — same pattern as WorkLog/NutriLog/Cipher.
- **Supabase backend** for cross-PC sync. Alex's apps all share one Supabase project called **lifelog** (`https://jpsisvaprkrcyvwnmasb.supabase.co`, region ap-southeast-1), each app using its own table prefix (`iron_*`, `ledger_*`, `nutrilog_*`, `cipher_*`). This app should follow the same convention — reuse the `lifelog` project, pick a new prefix (e.g. `postit_*`), don't spin up a separate Supabase project. Copy the anon URL/key pattern from an existing app's source (it's intentionally public client-side; access control is via RLS, not key secrecy).
- **No personal auth needed** — this is a shared team board everyone should see, closer to WorkLog's model (shared config, no per-user login) than Cipher's (per-user RLS via `auth.uid()`). "Main operator" / "request from" are just plain text/name fields, not tied to a login identity, unless Alex wants per-user accountability later.
- **Sync mechanism:** decide between Supabase Realtime (push updates instantly to every open PC — probably the better fit for a live shared board) or interval polling (simpler, what WorkLog uses for its sheet sync). Recommend Realtime for this app since the whole point is several people watching the same board.

## Draft data model (adjust with Alex before finalizing)

```sql
create table postit_notes (
  id          uuid primary key default gen_random_uuid(),
  work_name   text not null,
  due_date    date,
  requested_by text,
  operator    text,        -- main person responsible
  detail      text,        -- shown only after clicking into the note
  color       text default '#fff7b2',
  status      text not null default 'open' check (status in ('open','done')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```

## UI sketch

- Corkboard-style grid/wall of colored sticky note cards.
- Card face: work name (bold/title), due date (highlight if overdue), requested-by, operator initials or name.
- Click card → modal with full detail field, edit/delete, mark done.
- New Note button, similar styling to WorkLog's "+ Task" modal.
- Consider color-coding by operator (mirrors WorkLog's department color convention) — open question for Alex.

## Open questions for Alex (ask in the new chat, don't assume)

1. Should resolved notes disappear from the board, move to a "done" pile, or just get a strikethrough/faded style?
2. Fixed grid order, or freely draggable like a real corkboard (more work to build, nicer feel)?
3. Color-coded by operator, by urgency, or just a default sticky-yellow?
4. Any overdue highlighting wanted, like WorkLog's pending overdue feature?
5. Does this need to run standalone, or could it later embed into WorkLog as a board view? (Brief above assumes standalone per his request — just confirm.)

## Working with Alex

Alex is a novice developer — explain GitHub/Supabase/Electron setup steps explicitly (where to click in the Supabase dashboard, exact SQL to paste, etc.), don't assume familiarity. He works across two PCs and syncs code via git push/pull, data via Supabase — same expectations apply here.
