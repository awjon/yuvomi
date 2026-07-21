# Plan: Extend Yuvomi to the Google Suite (Tasks, Drive, Recipes, Birthdays)

## Context

Yuvomi (this fork) is a self-hosted family planner that already syncs with Google Calendar. The goal is to wire the rest of the Google suite into the other modules, reusing the same Google Cloud Console OAuth client:

1. **Tasks** — two-way sync with Google Tasks (pull lists in, push edits/completions back, optionally push local tasks to a chosen list).
2. **Documents** — sync chosen Google Drive folder(s) into the Documents section, plus Drive as a new upload storage backend.
3. **Kitchen → Recipes** — add-by-URL with server-side schema.org/Recipe extraction (no API key) **and** search via TheMealDB (free, no key) with one-click import.
4. **Birthdays** — invert the current direction: pull birthdays FROM Google Calendar (contacts "Birthdays" calendar, with fallback to any user-picked calendar); manual birthdays keep working locally.

This plan is written for the executor (Opus 4.8). **No code is executed during planning.** All work goes on branch `claude/family-planning-google-suite-msoacq` (already exists, checked out, tracked on origin) with one commit checkpoint per phase.

## Codebase conventions the executor must follow

- Node >=22, pure ESM, no build step. Express 5 (`server/routes/*` + `server/services/*`, REST mounted at `/api/v1/*` in `server/index.js:392-404`). Vanilla-JS SPA (`public/pages/*.js`, settings in `public/settings/pages/*.js` registered in `public/settings/registry.js`; all API calls via `public/api.js`).
- **Code comments and service headers are German** — match this in new files.
- SQLite via better-sqlite3; ALL schema changes are appended as numbered entries to the `migrations` array in `server/db.js` (current max ~85 — re-check `grep -n "version:" server/db.js | tail -3` before writing each). Function-style `up(db)` for table rebuilds (see migration 52).
- Key/value integration config lives in the `sync_config` table via `cfgGet/cfgSet/cfgDel` (pattern at `server/services/google-calendar.js:61-77`).
- Auth: `requireAuth`/`requireAdmin` from `server/auth.js`. Register new literal routes (e.g. `/google/tasklists`) **before** `/:id` routes in the same router.
- Every new endpoint gets an `server/openapi.js` entry (`op({ summary, tag, admin, stateChanging })`, see existing Google Calendar entries ~723-732).
- i18n: 23 files in `public/locales/*.json`; new keys required in `en.json` + `de.json` minimum (others fall back to English).
- Tests: plain `node test/test-*.js` scripts, `process.env.DB_PATH=':memory:'` BEFORE importing `server/db.js`, local `test/assert/assertEqual` helpers, exit code from fail counter; services expose internals via a named `__test` export (see `test/test-google-calendar.js`). Each new test gets a `test:xxx` package.json script AND is appended to the long `"test"` chain.
- `googleapis` is an **optionalDependency**, currently imported only in `server/services/google-calendar.js`. Keep top-level googleapis imports confined to `server/services/google-*.js`; non-Google modules (e.g. `document-storage.js`) must use lazy `await import()`. Check and replicate how `server/index.js` imports google-calendar today.
- Background scheduler: `runSync()` in `server/index.js:468-488` fans out to google/apple/ICS/caldav-reminders/holidays every `SYNC_INTERVAL_MINUTES` (default 15). Each new sync adds one guarded `.catch()`-wrapped line there; guards live inside each service's `sync()`.
- After every phase: `npm test` must pass + the targeted new test + the listed manual curl checks. One commit per phase; never squash phases.

## Phase 0 — Commit this plan (checkpoint 0)

This plan lives at `docs/google-suite-integration-plan.md` (matching the repo's tracked plan-doc convention, e.g. `docs/health-module-plan.md`; note `docs/plans/` is gitignored for internal Claude drafts). Commit on the designated branch and push:
`git add docs/google-suite-integration-plan.md && git commit -m "docs: add Google-suite integration implementation plan" && git push -u origin claude/family-planning-google-suite-msoacq`

## Phase 1 — Shared Google auth layer (prerequisite)

**Goal:** factor OAuth out of `google-calendar.js` into new `server/services/google-auth.js`. ONE consent flow requesting all scopes; existing token keys (`google_access_token`/`google_refresh_token`/`google_token_expiry` in `sync_config`) unchanged; Google Calendar behavior identical.

Create `server/services/google-auth.js` (moved/adapted from google-calendar.js):
- `SCOPES = { CALENDAR: '.../auth/calendar', TASKS: '.../auth/tasks', DRIVE: '.../auth/drive' }`, `ALL_SCOPES`.
- `createClient()` (moved verbatim, lines 45-55; env `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`).
- `cfgGet/cfgSet/cfgDel` (moved from 61-77, exported for other Google services).
- `getAuthUrl(session)` (moved from 247-257) with `scope: ALL_SCOPES`, `include_granted_scopes: true`, keep `access_type:'offline'`, `prompt:'consent'`, CSRF `state` in `session.googleOAuthState`.
- `handleCallback(code)` (moved from 263-276) + persist `tokens.scope` as `google_scopes` cfg key.
- `loadAuthorizedClient()` (moved from 209-231, incl. `tokens` event re-persist; also persist scope there).
- `getGrantedScopes()` / `hasScope(scope)`. **Backward compat:** tokens present but `google_scopes` unset → treat as calendar-only.
- `getAuthStatus()` → `{ configured, connected, grantedScopes, missingScopes }`; `disconnectAuth()` clears the four auth keys.
- `__test` export.

Modify:
- `server/services/google-calendar.js` — import the moved functions; **keep its exported surface identical** (re-export auth fns) so `server/routes/calendar.js` needs no changes this phase. `getStatus()` gains `grantedScopes` + `needsReconsent`; `disconnect()` calls `disconnectAuth()` plus calendar-specific cleanup; `sync()` early-returns without CALENDAR scope.
- `public/settings/pages/sync-calendar.js` (`buildGoogleProvider` ~828-1039) — when status has `needsReconsent: true`, show a "reconnect to enable Tasks/Drive/Birthdays" notice reusing the Connect button. This is the one-time re-consent path (`prompt:'consent'` forces a fresh refresh token with all scopes).
- `en.json`/`de.json` keys.

No migration, no new routes, no scheduler change.
Tests: new `test/test-google-auth.js` (scope parsing, backward-compat default, status shape, cfg round-trip, disconnect cleanup, `getAuthUrl` contains all 3 scopes + state — dummy env vars, no network). Existing `test-google-calendar.js` / `test-google-multi.js` must pass **unmodified** — proof of behavior preservation.

**Checkpoint 1:** `refactor(google): extract shared OAuth layer into google-auth service with combined scopes`

## Phase 2 — Google Tasks two-way sync

**IMPORTANT correction vs. naive design:** `tasks` ALREADY has `external_uid`, `external_source` (DEFAULT 'local'), `external_account_id` + index (db.js:1838-1847, added for CalDAV reminders sync in `server/services/caldav-reminders-sync.js`). **Reuse** `external_source='google'` and store the Google task id in `external_uid`. Do NOT re-add these columns. CalDAV prune queries filter on `external_source='caldav'`, so no collision.

### Migration 86
```sql
ALTER TABLE tasks ADD COLUMN google_tasklist_id TEXT;
ALTER TABLE tasks ADD COLUMN target_google_tasklist_id TEXT; -- mirror of calendar_events.target_google_calendar_id
ALTER TABLE tasks ADD COLUMN google_updated TEXT;            -- remote 'updated' RFC3339
ALTER TABLE tasks ADD COLUMN google_dirty INTEGER NOT NULL DEFAULT 0; -- local edit awaiting pushback
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_google_task
  ON tasks(google_tasklist_id, external_uid)
  WHERE external_source = 'google';

CREATE TABLE IF NOT EXISTS google_tasklist_selection (
  tasklist_id TEXT PRIMARY KEY,
  name        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 0,
  updated_min TEXT,   -- incremental cursor (Tasks API has NO sync tokens)
  last_sync   TEXT
);
```
(mirrors `google_calendar_selection`, migration v47 style.)

### New `server/services/google-tasks.js` (modeled on google-calendar.js; `google.tasks({version:'v1'})`)
- `listTasklists()` (paged `tasklists.list`, merged with selection — mirror `listCalendars()` at google-calendar.js:172-203).
- `setTasklistEnabled(id, enabled, meta)` — mirror `setCalendarEnabled` (123-150): on disable, delete `tasks WHERE external_source='google' AND google_tasklist_id=?`, reset cursor.
- `sync()` — guard: connected + `hasScope(SCOPES.TASKS)`, else return with logged status.
  - **Inbound** per enabled list: `tasks.list({ tasklist, updatedMin, showCompleted:true, showHidden:true, showDeleted:true, maxResults:100, pageToken })`. Next cursor = sync start timestamp; stale-cursor 400 → clear cursor + full re-list (mirror calendar's 410 handling at 354-360).
  - Mapping `googleTaskToLocal`: title→title, notes→description, `due` (date-only semantics) → `due_date = due.slice(0,10)` (`due_time` NULL), status needsAction→open / completed→done, `deleted:true`→delete row, `parent`→`parent_task_id` via two-pass upsert. `visibility='family'`, `created_by` = first user (same fallback as ics-subscription.js), store `google_updated`.
  - **Conflict rule:** inbound skips rows with `google_dirty=1` (local wins until pushed); otherwise remote wins.
  - **Outbound A (pushback):** rows `external_source='google' AND google_dirty=1` → `tasks.patch` via `localTaskToGoogle` (title, notes, due `YYYY-MM-DDT00:00:00.000Z`, status + completed timestamp; archived→completed). Clear dirty on success.
  - **Outbound B (export local):** rows `external_source='local' AND target_google_tasklist_id IS NOT NULL` → `tasks.insert`, then mark row as google-linked and clear target (mirror calendar outbound 377-411).
  - `pushTaskUpdate(id)` / `pushTaskDeletion(tasklistId, taskId)` (tolerate 404) for route hooks.
- `getStatus()`, `markDirty(id)`, `__test` export of mappers/upsert.

### Modify
- `server/routes/tasks.js` — new routes before `/:id`: `GET /google/status` (auth), `GET /google/tasklists` (admin), `PATCH /google/tasklists` (admin; toggle + sync), `POST /google/sync` (admin). Hooks: `PATCH /:id/status` and `PUT /:id` on google rows → set `google_dirty=1`, fire-and-forget `pushTaskUpdate(id).catch(...)` (scheduler retries via dirty flag). `DELETE /:id` → capture ids, fire-and-forget `pushTaskDeletion`. `POST /` accepts optional `target_google_tasklist_id` (validated against enabled lists). `GET /` includes new columns so the UI can badge.
- `public/pages/tasks.js` — "Google" badge on `external_source==='google'` cards; in `openTaskModal` (line 597)/save (~707-770): optional "Also add to Google Tasks" select of enabled lists when connected.
- `server/index.js` `runSync()` — `googleTasks.sync().catch(...)` after the googleCalendar block (same optional-import mechanism).
- New `public/settings/pages/sync-tasks.js` (copy structure from sync-calendar's `buildGoogleProvider`): status, tasklist checkboxes, Sync-now, re-consent notice. Register leaf in `public/settings/registry.js` (domain `sync`, adminOnly).
- `server/openapi.js`, `en.json`/`de.json`, `package.json` test script + chain.

Tests `test/test-google-tasks.js`: mapper round-trips, date-only due, upsert insert/update/delete-on-deleted, parent two-pass, disable purge, dirty-flag conflict skip, unique-index dedupe.

**Checkpoint 2:** `feat(tasks): two-way Google Tasks sync with tasklist selection and pushback`

## Phase 3 — Google Drive folder sync for Documents + `gdrive` upload backend

**Scope decision: full `https://www.googleapis.com/auth/drive`** (already in Phase 1's ALL_SCOPES). `drive.file` can't list arbitrary user-picked folders; `drive.readonly` can't upload. Fine for a self-hosted app with a user-owned OAuth client; note in docs that a published app would need Google verification.

### Migration 87 (function-style, modeled on migration 52's `family_documents` rebuild)
1. `CREATE TABLE google_drive_folder_selection (folder_id TEXT PRIMARY KEY, name TEXT, enabled INTEGER NOT NULL DEFAULT 0, last_sync TEXT);`
2. Extend `family_documents.storage_backend` CHECK to `('local','webdav','dms','gdrive')` — SQLite requires a **table rebuild** (migration 52 shows the exact pattern incl. preserving `dms_account_id` against `ON DELETE SET NULL`).
3. Recreate triggers `trg_family_documents_storage_insert/update` (db.js:1983-2017) allowing `(storage_provider='external' AND storage_backend='gdrive')`.
4. `CREATE UNIQUE INDEX ... ON family_documents(storage_key) WHERE storage_backend='gdrive'`.
sync_config keys: `document_storage_gdrive_enabled`, `document_storage_gdrive_upload_folder_id/_name`, `google_drive_last_sync`.

### New `server/services/google-drive.js` (`google.drive({version:'v3'})`)
- `listFolders(parentId='root')` — one-level browse for the picker (`q: mimeType folder + parent + !trashed`, `supportsAllDrives`).
- `setFolderEnabled(folderId, enabled, meta)` — on disable, delete gdrive rows of that folder (folder_id kept in `external_meta`).
- `sync()` — guard connected + DRIVE scope. Per enabled folder: `files.list` (id, name, mimeType, size, modifiedTime, webViewLink; modifiedTime polling — changes API noted as future optimization). Upsert into `family_documents` matched on `storage_key=file.id AND storage_backend='gdrive'`: `storage_provider='external'`, `external_url=webViewLink`, `external_meta` JSON `{folder_id, folder_name, modifiedTime, native}`, `content_data=''`, `visibility='family'`, category = the generic value of the 14-value CHECK (verify in db.js:946-982, likely `'other'`), `created_by` = first user. Delete rows whose file ids vanished.
- `uploadFile({buffer,name,mime,folderId})` (`files.create` multipart), `downloadFile(fileId)` (`alt:'media'` with 5 MB pre-check via `fields:'size'`; Google-native files → `files.export` to PDF/CSV, same cap; too large/unsupported → caller falls back to `external_url`), `deleteFile` (tolerate 404).
- `getStatus()`, `getUploadConfig()/setUploadConfig()`, `__test`.

### Modify
- `server/services/document-storage.js` — `getActiveUploadBackend()` (line ~106) precedence `local_folder > gdrive > webdav > local(BLOB)` (gdrive active when enabled + upload folder + tokens; read sync_config with this file's own helpers). New gdrive branches in `stageDocumentUpload` / `readDocumentContent` / `deleteDocumentContent` using **lazy `await import('./google-drive.js')`** (keeps googleapis optional); reuse `StorageError` codes incl. `DOCUMENT_STORAGE_TOO_LARGE`.
- `server/routes/documents.js` — before `/:id`: `GET /gdrive/status`, `GET /gdrive/folders?parent=`, `PATCH /gdrive/folders`, `PUT /gdrive/config`, `POST /gdrive/sync` (admin except status). Preview/download: on TOO_LARGE/native-export-failure for gdrive rows → redirect/return `external_url` (match how the frontend consumes preview — 302 if iframe/window.open, else 409+URL). Upload limit (5 MB) and MIME allowlist unchanged for uploads; imported metadata rows exempt (no local bytes).
- `public/pages/documents.js` — Drive badge + "Open in Drive" action (`external_url`).
- New `public/settings/pages/documents-gdrive.js` (mirror `documents-storage.js` structure): status + re-consent, folder browser with enable checkboxes, upload-backend toggle + folder choice, Sync now. Register leaf (domain `documents`, adminOnly).
- `server/index.js` `runSync()` — `googleDrive.sync().catch(...)`.
- openapi, locales, package.json.

Tests `test/test-google-drive.js`: file→row mapping (native vs regular, missing size), upsert idempotency, stale deletion, disable purge, `getActiveUploadBackend` precedence, migration sanity (('external','gdrive') insert OK; ('local','gdrive') rejected by trigger). Check `test-document-storage.js` for backend enumeration assertions and update if present.

**Checkpoint 3:** `feat(documents): Google Drive folder sync and gdrive upload backend`

## Phase 4 — Recipes: URL import + TheMealDB search (no Google dependency)

### New `server/utils/safe-fetch.js`
**Extract** the SSRF machinery from `server/services/ics-subscription.js` (`ipIsPrivate` ~36-48, `checkSSRF` ~77-95, `guardedLookup` 104-118 anti-DNS-rebinding, `ssrfSafeAgent` 125-128) plus a generic `fetchTextSafely(url, { maxBytes=2MB, timeoutMs=10s, headers, allowPrivate=false })` implementing the same normalize→checkSSRF→AbortController→streamed-size-cap flow as `fetchAndParse` (130-168), https-only (upgrade http→https). Then modify `ics-subscription.js` to import from it, **keeping its export list unchanged** (its private-network env opt-in stays ICS-local, passed as `allowPrivate`). Existing `test-ics-*` must pass unmodified.

### New `server/services/recipe-import.js`
- `parseRecipeHtml(html, sourceUrl)` — pure: extract all `<script type="application/ld+json">` blocks, tolerant JSON.parse, find `@type` Recipe (top level, arrays, `@graph`). Map `name`→title; `recipeInstructions` (string|string[]|HowToStep[]|HowToSection[]) → numbered plain-text notes (+ recipeYield/totalTime appended); `recipeIngredient[]` → `{name, quantity, category:'Sonstiges'}` with best-effort leading-quantity regex split. Cheap regex microdata fallback (`itemprop="recipeIngredient"`/`"ingredients"`, `itemprop="name"` inside `itemtype*="schema.org/Recipe"`). No title+≥1 ingredient → "no recipe found" error. Returns draft `{title, notes, recipe_url, meal_types:'', ingredients}`.
- `importFromUrl(url)` = fetchTextSafely + parseRecipeHtml.
- `searchTheMealDb(q)` — `https://www.themealdb.com/api/json/v1/1/search.php?s=` via fetchTextSafely; `mealDbToDraft(meal)`: strMeal→title, strInstructions→notes, strSource||themealdb URL→recipe_url, strIngredient1..20+strMeasure1..20 (skip blanks) → ingredients, `thumbnail` for UI. Handles `{"meals":null}`.
- `__test = { parseRecipeHtml, mealDbToDraft }`.

### Modify
- `server/routes/recipes.js` — before `/:id`: `POST /import-url` (auth, `{url}` → `{draft}`; 400 + translatable code on SSRF/parse failure — does NOT save) and `GET /search-external?q=` (auth → `{results}`).
- `public/pages/recipes.js` — in `openRecipeModal` (line 265): "Import from URL" input+button prefilling title/notes/recipe_url and rebuilding ingredient rows via existing `public/utils/ingredient-row.js`; "Search online" section (results with title/thumbnail, per-result "Use" prefill). Existing `saveRecipe` (349) and `/shopping/categories` dropdown unchanged.
- openapi, locales, package.json.

Tests `test/test-recipe-import.js` (fully offline): JSON-LD variants (@graph, @type array, HowToStep, entities), microdata fixture, no-recipe error, quantity-split heuristics, mealDbToDraft incl. blank skipping, SSRF rejects on literal private IPs without network.

**Checkpoint 4:** `feat(recipes): URL import (schema.org parser) and TheMealDB search with shared safe-fetch util`

## Phase 5 — Birthdays imported from Google Calendar (direction inverted)

Google → local only; imported rows read-only except reminder settings; manual birthdays untouched.

### Migration 88
```sql
ALTER TABLE birthdays ADD COLUMN external_source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE birthdays ADD COLUMN google_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_birthdays_google_event
  ON birthdays(google_event_id) WHERE google_event_id IS NOT NULL;
```
sync_config: `google_birthdays_enabled`, `google_birthdays_calendar_id`, `google_birthdays_last_sync`.

### New `server/services/google-birthdays.js`
- `CONTACTS_BIRTHDAY_CALENDAR = 'addressbook#contacts@group.v.calendar.google.com'`; `probeSource()` tries `events.list({calendarId, maxResults:1, eventTypes:['birthday']})` in try/catch (this calendar often absent from calendarList) → status `contactsCalendarAvailable`; **fallback:** settings lets user pick any calendar from `googleCalendar.listCalendars()` as source.
- `sync()` — guard enabled + connected. `events.list` on the source (eventTypes birthday for contacts calendar; otherwise client-side filter: `eventType==='birthday'` OR FREQ=YEARLY recurrence). Mapping: name = summary with best-effort strip of `/'s birthday$/i` and German `/ hat Geburtstag$/i` (raw summary if no match); `birth_date = event.start.date` (**year often absent/implausible** — store as-is; UI suppresses age when year ≥ current year); `external_source='google'`, `google_event_id`, `created_by` = first user.
- After upsert, call the **existing** `syncBirthdayCalendarEvent()` (birthdays.js:72-146) and `syncBirthdayReminder()` (148-181) per imported row — imported birthdays get the same local cake event + reminder support with zero new artifact code. Vanished/cancelled events → `deleteBirthdayArtifacts()` (190) + row delete.
- `setSource({calendarId, enabled})` (disable → purge imported rows + artifacts). **Duplicate-event mitigation:** if the source calendar is also enabled in `google_calendar_selection`, return `{warning:'calendar_also_synced'}` and surface in UI.
- `getStatus()`, `__test`.

### Modify
- `server/routes/birthdays.js` — before `/:id`: `GET /google/status` (auth), `PUT /google/source` (admin, → setSource + sync), `POST /google/sync` (admin). Guards: `PUT /:id` on imported rows → 403 unless body touches only reminder fields (then apply + `syncBirthdayReminder`); `DELETE /:id` → 403 for imported. Verify `syncAllBirthdayReminders` on `GET /` doesn't filter by source.
- `public/pages/birthdays.js` — badge/lock on imported entries, hide edit/delete for them, reminder-only edit affordance (reuse existing reminder-offset UI).
- `public/settings/pages/sync-calendar.js` — "Birthdays" subsection inside `buildGoogleProvider`: enable toggle + source selector (default "Google Contacts birthdays" when available, else calendar dropdown) + Sync now. (Lives here because it's calendar-sourced and the Google card is already on this page.)
- `server/index.js` `runSync()` — `googleBirthdays.sync().catch(...)`.
- openapi, locales, package.json.

Tests `test/test-google-birthdays.js`: name-stripping (EN/DE/no-match), upsert idempotency, artifact creation via real birthdays.js service (row gets `calendar_event_id`, `reminders` row exists), stale deletion cleans artifacts, read-only guard.

**Checkpoint 5:** `feat(birthdays): read-only import from Google contacts birthday calendar with reminder support`

## Phase 6 — Docs, i18n/openapi sweep, full verification

- Update README / `.env.example` Google section: combined scopes, one-time re-consent for existing installs, Drive full-scope rationale, new sync_config knobs. Changelog entry per `test-changelog.js` format constraints.
- Confirm every new i18n key exists in en+de (`test:frontend-audit`, `test:settings-navigation` enforce parts); openapi completeness (`test:api` validates spec).
- Full `npm test`; manual smoke with `SYNC_INTERVAL_MINUTES=1`: reconnect (re-consent), tasks/documents/birthdays populate, calendar sync still works.

**Checkpoint 6:** `docs: Google-suite setup docs, changelog, i18n and openapi completeness`

## Risks (encode in code, don't just note)

1. **Re-consent migration:** old installs have calendar-only tokens — every feature service guards on `hasScope()` and reports "reconnect required" instead of spamming 403s into the scheduler log every 15 min.
2. **googleapis optionalDependency:** top-level imports only in `server/services/google-*.js`; lazy imports elsewhere; replicate index.js's existing import guard for google-calendar exactly.
3. **Tasks API has no sync tokens:** `updatedMin` cursor = sync start time; invalid-cursor 400 → full resync.
4. **Rate limits:** sequential per-list/folder loops, page size ≥100, swallow-and-log per-item errors (like `upsertGoogleEvents`). Trivial at 15-min cadence.
5. **Drive vs 5 MB app limit:** proxy caps at 5 MB, native/oversize falls back to `external_url`; upload path limits unchanged.
6. **family_documents CHECK/trigger rebuild (migration 87) is the riskiest migration** — follow migration 52 exactly; `test-db`/`test-documents` are the safety net.
7. **Birthday API limitations:** minimal event fields, localized summaries, birth year often absent — display-grade data, read-only, never push back.
8. **SSRF (recipes):** all user-URL fetches via extracted `safe-fetch.js` (battle-tested ICS machinery).

## Verification (overall)

Per phase: targeted new test + full `npm test` + listed curl checks. End-to-end: run server (`npm start`), connect Google once (grants calendar+tasks+drive), set `SYNC_INTERVAL_MINUTES=1`, confirm all four modules populate/round-trip, and pre-existing Calendar sync tests (`test-google-calendar.js`, `test-google-multi.js`) pass unmodified after Phase 1.

## Post-approval first action (this session)

Commit this plan to `docs/google-suite-integration-plan.md` on `claude/family-planning-google-suite-msoacq` and push (checkpoint 0), so the executor starts from the committed plan.
