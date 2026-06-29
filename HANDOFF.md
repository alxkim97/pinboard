# Pinboard — Session Handoff

**Last updated:** 2026-06-27
**Current version:** v0.5.0
**Branch:** master

---

## App overview

Pinboard is an Electron app: a shared sticky-note board for the APm R&D team. Multiple people on multiple PCs see and edit the same board, synced live via Supabase Realtime. Separate from WorkLog by design — a simpler "post-it" concept rather than a feature added to WorkLog's task tracker. Runs in the background with a tray icon; notes can be "pinned" as small desktop widgets that live at the desktop layer itself (immune to "Show Desktop", sit behind normal windows automatically). Includes undo/redo, drag-to-complete via a recycle-bin icon or a stamp tool, and bilingual (English/Thai) UI.

**Key files:**

- `index.html` / `style.css` / `app.js` — main board window: Supabase client, free-form draggable board, modal, realtime sync, pin toggling, admin/lock UI, undo/redo, done-pile bin + stamp tool.
- `pin-widget.html` / `pin-widget.js` / `pin-widget-preload.js` — **one BrowserWindow per pinned note** (see "Architecture experiment that failed" below — do not try to consolidate these into one shared window without reading that first).
- `main.js` — Electron main process: single-instance lock, tray icon, auto-launch at login, creates the main window + per-note pin widget windows, persists pin positions/sizes to `pins.json`, global always-on-top setting in `settings.json`.
- `desktop-attach.js` — native Win32 interop (via `koffi`) that reparents pin widgets into the desktop icons' window layer (the Rainmeter trick).
- `preload.js` — context bridge for the main window (`window.pinAPI`).
- `vendor/supabase.js` — bundled supabase-js UMD build (loaded via `<script>`, no bundler needed).
- `assets/icon.ico` / `assets/icon.png` — app icon generated from the 📌 emoji via a throwaway Electron script (rendered emoji → `capturePage()` → hand-built ICO container).
- `supabase-setup.sql` — table + RLS policy + updated_at trigger + `pos_x`/`pos_y`/`locked` columns; paste into Supabase SQL Editor (idempotent, safe to re-run).

**Run (dev):** `npm install` then `npm start`
**Build installer/portable exe:** `npm run build` (electron-builder → `dist/Pinboard Setup <version>.exe` + portable; the portable target failed to launch when tested — use the installer, or `dist/win-unpacked/Pinboard.exe` directly).
**No local config file for Supabase** — the anon key is embedded directly in `app.js` (public by design; access is controlled by RLS). Pin window positions/sizes ARE stored locally per-PC in `<userData>/pins.json`; the always-on-top mode is in `<userData>/settings.json` (also per-PC).

---

## Architecture experiment that failed — read before touching pin widgets

On 2026-06-26 the per-window pin architecture (one BrowserWindow per pinned note) was consolidated into a **single shared overlay window** hosting all notes as DOM elements, specifically to cut down Electron renderer-process overhead on weaker PCs. It used a transparent, screen-spanning, click-through (`setIgnoreMouseEvents(true, {forward:true})`) window, reparented into the desktop layer via the same `desktop-attach.js` trick.

**It broke desktop-pin visibility in a way that got worse with each fix attempt:**
1. Notes only rendered after the cursor hovered over them (suspected Chromium renderer throttling).
2. Adding `backgroundThrottling: false` did not fix it.
3. Adding a one-shot resize-nudge redraw after `SetParent` did not fix it, and at one point desktop icons disappeared entirely while the overlay was visible (suggesting the "transparent" areas were compositing as opaque, not patchy throttling).
4. Switching to a periodic (1.5s) redraw nudge made it **worse** — notes stopped appearing even on hover.

The working per-note-window architecture (proven correct, confirmed by Alex multiple times) was restored. The likely root cause: the original per-note windows were small and NOT transparent/click-through — each window's content filled the whole window, no holes needed. The consolidated overlay needed a large mostly-transparent surface with click-through holes, and that combination apparently doesn't composite reliably once `SetParent`'d into a foreign process's (explorer.exe) window tree on this Windows build. **If revisiting consolidation for performance, this transparency+click-through+SetParent interaction is the specific thing to solve first** — don't just retry redraw-nudge variants, they've been exhausted.

Performance note: a real, separate, much higher-impact bug was found and fixed the same day — the old pre-single-instance-lock installed build had silently spawned **6 duplicate copies of itself** via "Start with Windows". That's likely the dominant cause of the "laggy on weaker PCs" complaint, not the per-process-per-note overhead. Worth confirming with Alex whether lag is still a real problem after he's been running v0.3.0 for a while before attempting consolidation again.

---

## Desktop pin widgets can't be live-dragged once attached — investigation 2026-06-27, fix UNVERIFIED

Discovered when Alex tried to drag a pinned note on the desktop (with "Keep Notes On Top" OFF, the default): the note's position updates correctly internally (`win.getPosition()` always matched the math exactly, confirmed via logging) but the screen never repaints it — it visually doesn't move at all.

**What was ruled out, in order, each confirmed by a real test (not just theory):**
1. Stale post-`SetParent` paint/z-order tracking → tried a resize-based redraw nudge (already used by `attachToDesktop`). No effect.
2. Same theory, stronger tool → tried `SetWindowPos` with `SWP_FRAMECHANGED`. No effect.
3. Z-order (note buried behind other app windows, since desktop-attached notes intentionally sit at the back) → tried `win.moveTop()` at drag-start. No effect, and confirmed directly: dragging over a fully empty desktop (every other window minimized) still showed zero movement.
4. Stale GPU/DirectComposition surface (Chromium never told about the native `SetParent` call) → tried a one-frame opacity flicker to force a recomposite. No effect.

**The one conclusive test:** a pin widget that has *never* been through `SetParent` (tested by temporarily skipping the initial `attachToDesktop` call) drags perfectly even with "Keep Notes On Top" OFF. So the live-drag breakage isn't about the window's *current* attach state — it's that once a window's HWND has ever been `SetParent`'d into Explorer's tree, something about its ability to redraw during rapid `setPosition` calls is permanently stuck, even after detaching it again. None of the usual redraw-nudge tricks undo it.

**Current fix attempt (in `main.js`, needs real-PC testing — Alex couldn't test on 2026-06-27):**
- A second, single, reusable, click-through (`setIgnoreMouseEvents(true)`) "shadow" `BrowserWindow` is created once at startup and kept hidden (`dragShadowWindow` / `createDragShadowWindow()`). It is **never** attached to the desktop layer, so it never gets tainted and always redraws correctly.
- On `pin:drag-start` (sent from `pin-widget.js` on the *first actual mousemove*, not on mousedown, to avoid a flicker on plain clicks): the real note window goes invisible (`setOpacity(0)`, chosen over `hide()` specifically so it keeps receiving mouse input normally — a hidden window stops getting input, which would break the drag), and the shadow window is positioned over it, force-topmost, and shown.
- `pin:move-by` (the existing per-mousemove handler) now also mirrors the same delta onto the shadow window, so the real (invisible) window's position stays correct the whole time — no separate sync needed at drag-end.
- `pin:drag-end`: real window's opacity restored, shadow hidden.
- **Separately discovered:** a note attached directly on creation (the default OFF path) still wouldn't drag even with all of the above; but a note that was toggled to "Always on Top" ON *first*, then OFF, *did* drag successfully under this same shadow-window code. Since both paths call the exact same `applyLayering(win, false)` → `attachToDesktop()`, the difference seems to be whether the window was ever shown as a normal (non-attached) floating window before its first attach. **Current code now codifies that sequence automatically**: every new pin window calls `applyLayering(win, true)` first, then (only if the global setting is actually OFF) `applyLayering(win, false)` again ~300ms later — replicating the proven-working manual toggle dance instead of attaching directly.
- **This last piece is UNVERIFIED** — Alex confirmed the *manual* toggle-dance works, but couldn't yet test whether the automatic version (in the code now) actually produces draggable freshly-pinned notes. Test this first next session, on a real PC with "Keep Notes On Top" OFF: pin a brand-new note, wait ~1s, try dragging it.
- **If it still doesn't work**: the agreed fallback (Alex's call) is to strip all of this back out and document dragging as only working in "Always on Top" mode — i.e., to reposition a desktop-attached note, toggle "Keep Notes On Top" ON, drag, then OFF again. Don't sink more time into native Win32 workarounds (e.g. global mouse hooks to decouple drag-tracking from any specific window's input) without Alex explicitly signing off — diminishing returns for a sticky-note app.

---

## Architecture

- **Supabase** (`pinboard_notes` table) — sole data store for note content. **Lives in the "worklog" Supabase project, NOT "lifelog"** — Pinboard is work-related, so it belongs alongside WorkLog's own project rather than the shared lifelog project used by Alex's personal apps. URL/key are in `app.js`, same constants as WorkLog's `config.json`.
- **Realtime**: subscribes to `postgres_changes` on `pinboard_notes`. Inserts/updates/deletes update the local UI directly from the write's own response, not by waiting on the realtime echo (an early bug had the board only update via realtime, so your own new note wouldn't appear until something else triggered a re-render). Realtime is now purely for syncing *other* clients' changes to you.
- **No auth** — shared team board, anon key only. A lightweight **admin PIN** (`ADMIN_PIN` constant in `app.js`, currently `alex456`) gates a client-side-only "admin mode" that lets the unlocker lock/unlock notes (locked notes can't be dragged or edited by non-admins, but can still be deleted/marked done by anyone). Soft UI gate, not real security — RLS still allows anyone with the anon key to write directly.
- **Free-form draggable board**: every note has `pos_x`/`pos_y`, synced for everyone. New notes get an auto-assigned cascade position on first render, persisted immediately (without an undo entry — see below). Dragging is hand-rolled (mousedown/mousemove/mouseup with a module-level `dragState`), and the board scrolling is fully disabled (`overflow:hidden` on html/body) — drag positions are clamped to the visible viewport so notes can't be dragged somewhere inaccessible.
- **Desktop pin widgets**: each pinned note is a separate frameless, `skipTaskbar`, resizable (`setAspectRatio(1)` keeps it square) BrowserWindow (`pin-widget.html`). Clicking one sends `pin:request-open-main` → main process focuses/shows the main window → sends `pin:open-detail` → `app.js` opens that note's edit modal. Realtime updates/deletes to a pinned note are relayed from the main window's renderer to its widget via `window.pinAPI.refresh()` / `.close()`.
- **Always-on-top is a single global setting**, not per-note. Toggled via tray menu → "Keep Notes On Top" checkbox, stored in `settings.json`, applied to all open pin windows at once via `applyLayering()` in `main.js`.
- **Desktop-layer attachment (`desktop-attach.js`)**: when "Keep Notes On Top" is OFF (the default), pin widgets are `SetParent()`'d into the Windows desktop's own window hierarchy (the Rainmeter trick) instead of being a normal floating window — immune to "Show Desktop", sits behind normal windows automatically. Uses `koffi` for native Win32 calls (chosen over `ffi-napi` because it ships prebuilt binaries — no node-gyp/Visual Studio Build Tools needed). This Windows build doesn't have the classic sibling-WorkerW layout — `SHELLDLL_DefView` is a direct child of `Progman` — so there's a fallback parenting directly under `Progman`. When "Keep Notes On Top" is ON, widgets detach and become normal always-on-top windows instead.
- **Single-instance lock** (`app.requestSingleInstanceLock()`) — critical, do not remove. Without it, "Start with Windows" plus a manual launch silently spawns duplicate tray icons/windows fighting over the same `pins.json`. A stale `lockfile` in `<userData>` from a force-killed process can also wedge this — delete it if a fresh launch silently exits with code 0 and no other instance is actually running.
- **Undo/redo**: `undoStack`/`redoStack` of `{kind, id, before, after}` actions, tracking only this client's own edits (never pushed from realtime echoes of other PCs' changes). `kind: 'create'|'delete'` re-insert/remove the whole row (re-insert reuses the original `id`); `'edit'|'status'|'lock'|'position'` are column-level before/after patches applied via the same update path. Ctrl+Z/Ctrl+Y (or the toolbar buttons) — disabled while a modal is open or a text field has focus, so native text-undo in inputs isn't hijacked. Auto-assigned default positions and bin-drop repositioning intentionally do NOT push undo entries (`persistPosition(id, x, y, false)`).
- **Done pile**: a 🗑️ bin icon (bottom-right, fixed position) replaces the old text "Done" toggle. Drag a note onto it, or use the ✔️ stamp tool (drag it onto any open note) to mark done — both play a "Done / เสร็จ" stamp animation in place on the board before the note moves to the done panel. Dragging a note out of the done panel back onto the board reopens it at the drop position.
- **Packaging**: electron-builder, `npm run build` (NOT `build:win` — Alex wants the same script name across all his apps, see memory). `koffi`'s native binary needs `asarUnpack` in `package.json`'s `build` config — native `.node` files can't load from inside an asar archive.
- **Auto-update**: `electron-updater`, GitHub Releases provider (`build.publish` in `package.json`, pointed at `alxkim97/pinboard`). Checks 10s after launch and every 4h thereafter (silent if nothing found), plus a tray "Check for Updates" item for an explicit check that always reports back. `autoInstallOnAppQuit: true` — a downloaded update installs on next quit even if Alex dismisses the "Restart Now" dialog. To actually publish a release: `npm run build -- --publish always` with a `GH_TOKEN` env var (a GitHub PAT with `repo` scope) set, which uploads the installer + `latest.yml` to a new GitHub Release tagged with `package.json`'s version.

---

## Database schema

```sql
pinboard_notes (
  id uuid PK, work_name text, due_date date,
  requested_by text, operator text, detail text,
  status text ('open'|'done'),
  pos_x double precision, pos_y double precision,
  locked boolean default false,
  created_at timestamptz, updated_at timestamptz (auto via trigger)
)
```

---

## Decisions made (don't re-litigate)

- **Standalone app**, not a WorkLog board view (though see "future plan" below — Alex floated making Pinboard the primary R&D entry point with posts linked into WorkLog; not started, just noted).
- **Done notes** go to a 🗑️ bin (bottom-right, click to view contents) — not a text toggle button (that collided with board content at one point), not a fixed-position dropdown panel.
- **Free-form draggable board, synced for everyone** — reversed from an earlier "fixed grid" choice once Alex actually tried it and wanted real dragging. Board itself does not scroll at all (drags are clamped to viewport).
- **Per-note desktop windows, NOT a consolidated overlay** — see "Architecture experiment that failed" above.
- **Color palette**: 10 fixed sticky-note colors assigned per operator via hash — not a continuous hue (looked washed out for short names).
- App named **Pinboard**. Supabase backend: **worklog** project (not lifelog).
- **Always-on-top is global**, not per-note; defaults to OFF (desktop-attached) — Alex found floating-on-top annoying for routine use.
- **Admin lock**: shared PIN gate, not real per-user accounts. Lock blocks dragging + editing fields only — NOT delete or mark-done.
- **Resize stays square** (`setAspectRatio(1)` on the native window).
- **Due-soon threshold**: 2 days (`DUE_SOON_DAYS` constant, duplicated in `app.js` and `pin-widget.js` — keep in sync if changed). No continuous CSS animation on it (was a real perf concern raised — static glow instead).
- **Bilingual UI** (English / Thai) on all main buttons and modal labels.
- **Build script is named `build`**, not `build:win` (see [[feedback-electron-build-script-name]] memory) — applies to all Alex's Electron apps.
- **Undo/redo scope**: create/delete/edit/status/lock/position are undoable; pin/unpin and admin-mode toggle are not (local-only state, not board data).

---

## What to continue next session

1. **Test on a second PC** — confirm notes/positions sync live, and confirm the desktop-attach trick behaves the same on a different Windows build (it's explicitly version-fragile — this PC's build (26200) needed the Progman-direct-parent fallback).
2. **Portable exe build doesn't launch** (the NSIS installer and `win-unpacked/Pinboard.exe` both do) — not investigated, low priority. Note: electron-updater also doesn't support auto-updating the portable target on Windows anyway, only NSIS — another reason the installer is the one to distribute.
3. Alex may still have a stale installed copy in `C:\Program Files\Pinboard\` from earlier testing sessions — confirm he's running the latest build.
4. Verify `desktop-attach.js`'s Progman fallback survives an Explorer restart — not yet tested.
5. **Auto-update — wired up 2026-06-26, confirmed working 2026-06-27 (v0.4.0+).** `electron-updater` against GitHub Releases (`github.com/alxkim97/pinboard`), checks 10s after launch then every 4h, tray "Check for Updates" item. App launches and runs fine with it in place. **Still not tested against a real published release** — that needs `npm run build -- --publish always` with a `GH_TOKEN` (GitHub PAT, `repo` scope) to actually verify the download/install path end-to-end.
6. **Pinned-note dragging — fix attempted 2026-06-27, UNVERIFIED, see the dedicated section above.** Top priority for next session: test whether a freshly-pinned note (default "Keep Notes On Top" OFF) is now draggable. If not, fall back to documenting the manual toggle-on-then-off workaround instead of continuing to chase it.
7. **Future idea (not started, just noted 2026-06-26)**: Alex floated making Pinboard the primary entry point for R&D staff, with posts linked into WorkLog, since WorkLog is harder to use for anything beyond viewing the schedule. No design work done on this yet.

---

## How to continue on another PC

**Step 1 — Pull latest** (once the GitHub remote exists — see item 5 above, it may not yet)
**Step 2 — Run `npm install`** in the pinboard folder
**Step 3 — Paste this into a new Claude Code session:**

```text
Continue Pinboard development. Read HANDOFF.md for full context. Current version: v0.5.0.

Key facts:
- Electron 31, vanilla HTML/CSS/JS, Supabase client straight in app.js (no IPC for data)
- Supabase backend: pinboard_notes table in the "worklog" Supabase project (NOT lifelog)
- Free-form draggable board (no scroll, clamped to viewport), positions synced via pos_x/pos_y
- Admin PIN ("alex456" in app.js) gates note locking (blocks drag+edit, not delete/done)
- Desktop pin widgets: ONE BrowserWindow PER NOTE — do NOT consolidate into a shared overlay
  window without reading the "Architecture experiment that failed" section in HANDOFF.md first,
  it broke visibility badly across several fix attempts
- desktop-attach.js (koffi/native Win32) attaches pin widgets to the desktop layer; fragile,
  has a Progman-direct-parent fallback for newer Windows builds
- Always-on-top is ONE global setting (tray menu checkbox), not per-note
- Single-instance lock is critical — don't remove it; a stale lockfile in <userData> can wedge
  it after a force-kill (delete the file if launches silently exit with no other instance running)
- Undo/redo: Ctrl+Z/Ctrl+Y + toolbar buttons, tracks this client's own edits only
- Done pile is a 🗑️ bin icon (bottom-right) + a ✔️ stamp-drag tool, not a text toggle
- Run: npm start | Build: npm run build (electron-builder, NOT build:win)

GitHub remote: github.com/alxkim97/pinboard (published). electron-updater is wired and runs fine,
but untested against a real published release (needs npm run build -- --publish always + GH_TOKEN).

TOP PRIORITY: pinned-note dragging fix is UNVERIFIED — see "Desktop pin widgets can't be
live-dragged once attached" section in HANDOFF.md for the full investigation. Test first: pin a
brand-new note with "Keep Notes On Top" OFF, wait ~1s, try dragging it. If still broken, the
agreed fallback is to strip the shadow-window/toggle-dance code back out and document dragging
as Always-on-Top-only — don't keep sinking time into native Win32 workarounds without Alex's
explicit go-ahead.

Other pending: portable exe build doesn't launch (installer does, and isn't auto-updatable
anyway); not tested on a second PC yet; desktop-attach Progman fallback not verified to survive
an Explorer restart.
```
