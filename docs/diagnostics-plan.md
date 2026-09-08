# Pad diagnostics / sync flight recorder plan

Status: core implemented in Pad on 2026-09-07. The local flight recorder,
hidden PWA sheet, redacted bounded reports, semantic sync/document/storage/
sharing telemetry, request aggregation/burst detection, local invariants, and
read-only current-page Yjs check are implemented. The deeper optional Tallpond
SDK socket observer described in Phase 3 remains platform work; Pad currently
records every app subscription's status/error and its own semantic requests.

## Decision summary

Build one **local-first diagnostics system inside Pad**, not a conventional
analytics pipeline and not a stream of console logs.

It should:

- record a small, structured, always-on flight recorder so an intermittent
  problem is still explainable *after* it occurs;
- aggregate routine successes and retain individual failures, slow operations,
  retries, state transitions, and invariant violations;
- expose a hidden Diagnostics sheet in the installed PWA and normal browser;
- generate one bounded, plain-text report designed to paste into an agent chat;
- include an optional, read-only consistency check for the current page;
- never upload anything automatically;
- never record page titles, Markdown, Yjs payloads, handles, auth material, raw
  share/note/user IDs, file paths, or query values.

Normal target report size: **4–8 KB**. Hard maximum: **16 KB**. The report is a
summary with a short causal timeline, not a dump of every event.

## Why the current signals are insufficient

Pad currently has several independent indications of health:

- `SyncState.phase`, `pending`, `fullSyncing`, and one flattened error string;
- an active document transport (`local | connecting | live | offline`);
- Tallpond subscription status callbacks on the active document only;
- request IDs appended to some SDK errors;
- browser online/offline state;
- a temporary keyboard debug overlay behind the five-tap gesture.

These signals are presentation state, not diagnostic history. By the time a
user reports “Sync failed” we cannot answer:

1. Which operation failed: auth, full inventory, outbox drain, active document
   backfill, realtime ticket/socket/snapshot, room move, asset upload, or UI
   refresh?
2. Was this one failed request, repeated retry, a request storm, or a stale
   operation blocked behind another operation?
3. Did local durability succeed before the network failed?
4. What is pending, how old is it, and is it routed to the note's current
   resource/room?
5. Did realtime ever become live, reconnect with a sequence gap, resync its
   snapshot, or silently remain offline?
6. Does local metadata/body state actually differ from the server, or is only
   the status indicator stale?
7. Was a share migration, account scope switch, full sync, and active-page open
   overlapping when the divergence appeared?
8. Which production build and service worker was actually running?

The existing architecture makes those distinctions especially important:

- `fullSync()` is a single-flight, multi-stage inventory and reconciliation;
- share migration deliberately blocks full sync and tears down subscriptions;
- outbox drain merges body updates, coalesces metadata, blocks deleted-elsewhere
  notes, and treats content 403/404 differently from metadata 403/404;
- active-page content does an explicit backfill before starting its live tail;
- the SDK has one socket per scope, reconnect/resume, and snapshot resync;
- browser online status does not prove the gateway or socket is reachable;
- `SyncState.error` is cleared by later success, erasing the useful history.

## Product shape

### One system, three layers

1. **Flight recorder** — always on, tiny, local, bounded. Captures enough context
   to explain an issue that already happened.
2. **Diagnostics sheet** — hidden UI showing current health and allowing a user
   to copy, clear, or run a check.
3. **Consistency check** — explicit read-only network probe for the current page
   when the flight recorder alone cannot determine whether local and remote
   state differ.

“Debug mode” should increase detail and expose the sheet; it must not be the
thing that starts recording. Asking a user to enable recording before an
intermittent failure guarantees the important incident is missed.

### Access in browser and installed PWA

Use the existing hidden interaction, but turn it into a durable unlock rather
than reloading into a keyboard-only overlay:

- Seven taps on a small `Pad · <build>` row at the bottom of Settings unlocks a
  `Diagnostics` menu item for that device.
- Opening `/?pad-diagnostics=1` also unlocks and opens it in an ordinary browser.
- Once unlocked, persist the visibility flag locally until “Hide diagnostics.”
- The sheet itself works offline and in standalone display mode.

Do **not** require a separately installed debug PWA. A second manifest/start URL
adds update, storage-partition, and support ambiguity while providing no useful
capability. A same-origin URL can remain a convenience for desktop testing, but
all controls must be reachable from the installed app without editing its URL.

Replace the current keyboard overlay/`motion-debug` mechanism with a keyboard
category in this system. Keyboard details may be shown live in the sheet while
it is open, but should not paint a permanent overlay over the editor.

### Sheet layout

Keep this utilitarian and agent-facing:

```
Diagnostics                         [Close]
Sync degraded
3 queued changes · oldest 1m 42s
Realtime: page live · metadata reconnecting 18s
Last failure: full-sync/resource-inventory · 503 · req_…

[Copy report]  [Run current-page check]
[Retry sync]

Recent notable activity
12:03:11 full-sync failed after 4.2s at workspace inventory
12:03:07 request burst: 38 requests / 2s, mostly members.list
12:02:58 realtime workspace resumed after 6.8s

Build / device / storage                  [expand]
Clear diagnostic history · Hide diagnostics
```

The default view is a health summary and at most 8 notable entries. It is not a
scrolling raw log viewer. “Copy report” is the primary action.

Clipboard fallback matters on mobile: if `navigator.clipboard.writeText` fails,
show a selected read-only textarea and a Download `.txt` action.

## Data model

### Typed records, not strings

Use a standalone `src/diagnostics.ts` module with a narrow API:

```ts
type Domain = 'boot' | 'auth' | 'sync' | 'outbox' | 'realtime' |
  'document' | 'storage' | 'sharing' | 'assets' | 'service-worker' |
  'network' | 'keyboard'

type Level = 'info' | 'warn' | 'error'

type DiagnosticEvent = {
  schema: 1
  at: number                 // wall time, for cross-reload ordering
  mono: number               // performance.now(), for durations this boot
  boot: string               // short random boot alias
  domain: Domain
  name: string               // finite typed vocabulary
  level: Level
  operation?: string         // e.g. fs3, fl8, doc4, share2
  fields?: Record<string, string | number | boolean | null>
}
```

Provide only a few primitives:

- `event(domain, name, fields?)`
- `warn(...)` / `failure(...)`
- `span(domain, name, fields?)` returning `end(outcome, fields?)`
- `count(domain, name, dimensions?, amount = 1)`
- `gauge(domain, name, value)`
- `snapshot(reason)`

Every field is allowlisted per event type. Do not expose a generic “log any
object” method; that is how content and giant server payloads eventually leak
into reports.

Diagnostics must never throw into product code. Bad fields are dropped, event
callbacks are guarded, and persistence failures become one in-memory warning.

### Identity aliases

Reports need to correlate “the same page/resource” across events without
copying identifiers.

- Generate report-local aliases: `note-1`, `workspace-1`, `room-1`, `user-self`.
- Alias only IDs referenced by retained events/current state.
- Never write the source IDs to the report.
- Persisted recorder entries may store a keyed digest (installation-local random
  salt) when correlation across boots is necessary; truncate to 8–10 chars.
- Do not use an unkeyed hash: UUIDs are not human content, but a raw hash still
  becomes a stable external identifier.

Gateway request IDs are the exception. Preserve them verbatim on failures and
slow requests because they are the server-side correlation key and contain no
user content.

### Retention and storage

Use two bounded stores because the diagnostics system must also explain local
DB startup failures:

1. **Memory ring** for the current boot: up to 200 notable records plus
   aggregators.
2. **Small localStorage crash capsule**: compact current/previous boot summary,
   last 30 notable records, and active operation markers; hard cap 48 KB.

Persist the capsule:

- debounced after notable events (roughly once per 2 seconds at most);
- immediately after an error/invariant violation;
- on `visibilitychange` to hidden and `pagehide`.

Do not put the only diagnostic history in Pad's scoped IndexedDB. IndexedDB
blocked/version/transaction failures are themselves incidents we need to see.
A future larger diagnostic DB is unnecessary unless field reports prove 48 KB
insufficient.

Retention policy:

- current boot plus the two previous boot summaries;
- last 10 minutes of notable timeline when available;
- aggregate counters for the whole current boot;
- automatic removal after 7 days;
- explicit “Clear diagnostic history.”

No recorder timer should exist solely for diagnostics. Flush on existing events
and lifecycle signals to avoid mobile battery cost.

## What to record

### 1. Build, runtime, and PWA context

Once per boot:

- build commit/release identifier and report schema;
- app-shell asset version and service-worker script version;
- whether a service worker controls the page and controller changes;
- display mode (`standalone`, browser, fullscreen);
- browser engine/family and major version, OS family, mobile boolean;
- viewport and visual viewport sizes (rounded);
- `navigator.onLine`, visibility state, effective connection type when exposed;
- local storage availability, IndexedDB open duration/result;
- storage usage/quota rounded to MB and persistent-storage result when exposed;
- current local scope matches confirmed user: yes/no/unknown (never the ID).

Do not copy the full user-agent string. It is noisy and fingerprint-heavy.

Inject the git SHA/build timestamp through Vite constants. The SW template
should expose the same shell cache version to the page (message response or a
small generated build constant) so a report can detect “new JS under old SW” or
vice versa.

### 2. Network, aggregated by operation signature

Routine successful requests belong in aggregates, not the timeline.

For each signature collect:

- logical endpoint (`auth/session`, `db/query`, `resources/list`,
  `realtime/ticket`, `members/list`, `files/upload`, etc.);
- DB query operation/table/scope kind when known, never filters or values;
- count, success/error/cancel count;
- total duration, max duration, and coarse p50/p95 buckets;
- request and response byte count only when cheaply available;
- maximum global in-flight count.

Create an individual notable event only for:

- non-2xx response;
- thrown network error;
- cancellation (only if not an expected active-page abort);
- duration above 2 seconds;
- a 401 refresh/retry path;
- malformed/non-JSON gateway response;
- request burst threshold.

Burst detector: when more than 25 requests start in a rolling 2-second window,
emit one event containing total count, peak in-flight, top three signatures,
and the owning semantic operation. Suppress repeated burst events for 10
seconds while counters continue. This directly catches the previous
members/profiles and workspace fan-out storms without logging 3,000 lines.

For an error retain status, Tallpond error code, request ID, and a tiny allowlist
from error data (`upstream_status`, `upstream_request_id`, billing code). Never
retain complete error payloads, URLs with query strings, headers, cookies,
request bodies, response bodies, or file paths.

### 3. Sync engine state machine

Every `SyncState` transition should carry a **reason**, not just a patch. Add an
internal setter like `transition(reason, patch)` and record only meaningful
changes:

- phase / connected / fullSyncing transitions;
- pending count crossing `0 -> nonzero`, changing by a significant amount, or
  returning to zero;
- error latch/clear;
- retry scheduled, retry attempt/delay, retry canceled;
- auth verification started/result;
- scope swap started/completed/failed;
- subscriptions closed/rebuilt and why.

A report should be able to distinguish these currently identical red states:

- full inventory failed but outbox is durable;
- outbox write failed;
- realtime failed while HTTP sync is healthy;
- auth is genuinely expired;
- browser says offline;
- active document backfill/live failed while metadata sync is healthy.

### 4. Full sync span

Give every `fullSync()` execution an operation ID (`fsN`) and one parent span.
Record stage durations and compact counts:

1. waiting for share migration;
2. private metadata and mount inventory;
3. resource list;
4. shared inventory worker pool;
5. local metadata apply;
6. mount apply;
7. absence reconciliation;
8. membership-end confirmations/removals;
9. pending room grants;
10. live subscription rebuild;
11. outbox drain;
12. purge;
13. settle.

Per run retain:

- trigger (`startup`, `online`, `focus/account-change`, `workspace-open`,
  `membership-change`, `room-grant-change`, `manual`, `share-followup`);
- whether it joined an existing single-flight or started one;
- resources, rooms, metadata rows, pages/cursors, local writes;
- worker concurrency and slowest three workspace inventories by alias/duration;
- absent notes examined/removed/conflicted/skipped-because-scope-changed;
- shares nominated/confirmed-ended/kept-inconclusive;
- final pending count and outcome;
- failed stage plus normalized error.

Do not emit one event per resource or row. Keep stage aggregates and only the
slowest few outliers.

### 5. Outbox health

A current snapshot and each drain span should include:

- total ops by `note` vs `update`;
- ops by private/resource/room scope kind;
- distinct note count;
- age of oldest op;
- bytes of queued update payloads (not payload content);
- drain passes;
- update groups merged, payload bytes in/out;
- metadata update/insert/existing counts;
- accepted, permanently rejected, transiently failed, blocked-conflict counts;
- whether a pass made no progress;
- queue delta and drain duration.

High-signal warnings:

- oldest op exceeds 2 minutes while online and connected;
- pending count grows across three completed retries;
- a content update receives 403/404 and remains queued;
- an op's recorded share/room does not match its current note;
- queue is nonempty while phase says `synced`;
- the same metadata op loses its revision race repeatedly.

This is more useful than every request because it answers the user-level
question: “Is my writing still safely on this device, and why is it not moving?”

### 6. Realtime/socket health

Pad-level `.on('status')` cannot fully explain socket behavior; the SDK should
add an optional, non-throwing diagnostics observer to `createClient`.

Proposed SDK surface:

```ts
createClient({
  diagnostics: {
    request(event) { ... },
    realtime(event) { ... },
  }
})
```

The SDK emits metadata-only events. The application owns redaction/storage.
This avoids monkey-patching global `fetch` or `WebSocket`, accidentally logging
socket tickets, and coupling Pad to private SDK internals.

Request observer fields:

- logical request ID and physical attempt number;
- path category/method;
- start/end/duration;
- status/request ID;
- retry cause (`session-refresh`, `agent-remint`, none);
- outcome (`ok`, `http-error`, `network-error`, `abort`).

Realtime observer fields:

- socket alias/scope kind (raw scope passed only to the observer callback for
  app-side aliasing, never formatted by the SDK);
- connect start, ticket success/failure, open, hello;
- offline/close code and whether hello was reached;
- reconnect attempt and selected delay;
- watched table names/count;
- hello/resume watermark and sequence gap size;
- resync reason/start/end, snapshot table/row count/duration;
- change counts by table/op (aggregated in Pad);
- access revoked and server protocol errors;
- socket disposal reason / remaining subscription count.

Never include the realtime ticket, subprotocol, row, query filters, or payload.

Until that SDK version is published, instrument app subscription status/error
and semantic request spans. Do not ship a global WebSocket wrapper as a
“temporary” solution; it is precisely the sort of second debug system this plan
is intended to avoid.

### 7. Active document / Yjs pipeline

Per open-document operation (`docN`):

- note/workspace/room aliases and writable boolean;
- local IndexedDB body read duration and encoded byte size;
- wait for previous pending write: duration and timeout boolean;
- backfill page/row/payload-byte count and duration;
- backfill cancellation classified as expected navigation, not failure;
- malformed payload count;
- merged update byte size;
- self-heal diff generated/queued and byte size;
- compaction started/result, rows inserted/deleted, duration;
- live transport state transitions and time to live;
- received insert count and merged bytes (aggregate only);
- local persist count, slowest duration, failure count;
- local enqueue count/failure count;
- controller close reason and lifetime;
- presence subscription status and aggregate publish failures, without cursor
  offsets or display names.

Important warnings:

- previous write wait reaches the 2-second limit;
- active backfill exceeds 3 seconds;
- HTTP backfill succeeds but live never reaches `live` within 15 seconds;
- doc says `live` while its underlying scope socket is offline;
- local persistence/enqueue failure;
- controller is reopened for the same note while a write is outstanding;
- remote update is applied after controller close (should be impossible).

Do not record text length on every keystroke. If useful, sample only encoded
state byte size at open/check/close; document length can itself leak content
shape and adds little diagnostic value.

### 8. Sharing, rooms, membership, and assets

Record parent spans for user-triggered operations, because they often explain a
full sync or request burst immediately afterward:

- workspace create/recover;
- note-tree promotion (selected-only vs subtree, note count);
- private-row retirement;
- move to room (metadata/update row counts and destination kind);
- create room / grants application;
- invitation/member/role action;
- pending grant completion;
- visual asset upload/download/move (size and scope kinds only).

For share migration record every stage boundary, barrier wait, subscription
teardown/rebuild, local scope changes count, outbox drain result, and final
outcome. Persist the active operation marker immediately so a reload can report
“previous boot ended during private-row retirement,” which is otherwise almost
impossible to reconstruct.

Never include workspace/page names, member handles, asset paths, or invite URLs.

### 9. Local integrity checks

Run cheap checks when generating a report; they require no network and no extra
background work:

- current local scope agrees with confirmed user scope;
- note counts by private/shared/custom-room/deleted/remote-known state;
- parent cycles;
- unresolved parents (counted separately because they can be valid access
  boundaries);
- outbox rows whose note is missing;
- update ops whose share/room differs from current note;
- shared notes with unknown role/grant;
- active note missing from the current store;
- stale `motion-share-migration:*` and pending-grant markers;
- pending op age;
- docs/assets without note rows, reported as counts only;
- sync claims `synced` while outbox is nonempty;
- migration and full-sync barriers both marked active unexpectedly.

Classify each result as `ok`, `warning`, or `failure`; do not dump every note.

## Read-only current-page consistency check

“Out of sync” needs a real comparison, not just telemetry. Add an explicit
button that performs a bounded check for the active page only.

Prerequisites: connected, online, active page. It must not write, compact,
remove, reconcile, or trigger `fullSync()`.

### Metadata check

1. Read the page's expected remote table in its current private/resource/room
   scope by `noteId`.
2. Report `missing`, `one row`, or `duplicate/ambiguous`.
3. Compare title **without revealing it** (equal boolean), parent ID (equal
   boolean/aliased), delete timestamp, client revision, creator presence, and
   expected room/scope.
4. For a recently migrated page, also probe the previous/private location only
   when a migration marker or recorder event makes that relevant.

### Body check

1. Load local Yjs encoded state.
2. Fetch all remote update rows for this note with a strict row/byte/time limit.
3. Merge the remote log in memory.
4. Compare Yjs state vectors in both directions:
   - `localAheadBytes`: update needed to bring remote to local;
   - `remoteAheadBytes`: update needed to bring local to remote.
5. Interpret alongside the outbox:
   - both zero: equal;
   - local ahead + queued update: expected pending;
   - local ahead + no queue: likely enqueue/drain loss;
   - remote ahead: active local cache/live tail is stale;
   - both ahead: concurrent/divergent but mergeable CRDT histories.
6. Destroy probe docs and payload arrays immediately after the result.

The report includes only equality/classification, row count, byte counts, and
request IDs. No update payloads, state vectors, Markdown, or hashes of content.

### Scope and limits

Default to current page because a whole-account probe repeats the expensive
behavior we are trying to diagnose. Suggested caps: 1,000 update rows, 8 MB,
10 seconds. If exceeded, report `inconclusive: limit reached`.

A later “workspace index check” may compare metadata ID/revision sets in one
resource, but it should be an explicit advanced action, not part of copying a
normal report.

## Report format

Plain text is easier than JSON for Carson and still structured enough for an
agent. Stable section names and `key=value` fields allow parsing.

Example (illustrative):

```text
PAD DIAGNOSTICS v1
captured=2026-09-02T19:14:22Z window=10m privacy=redacted
build=ce06cb6 shell=pad-shell-a81d09 controlled=yes mode=standalone
runtime=iOS/WebKit mobile online=yes visible=yes storage=18/512MB
boot=b3 previous_end=hidden previous_active=none

HEALTH degraded
sync=error connected=yes full_sync=no pending=3 oldest=1m42s
realtime private=live workspace-1=offline(18s) document=connecting
local notes=84 private=12 shared=69 custom_room=3 deleted=4
last_error op=fs3 stage=shared_inventory status=503 request=req_abc

INVARIANTS ok=8 warn=1 fail=0
warn outbox_route_mismatch count=1 note=note-2 expected=workspace-1/room-1

OPERATIONS
fs3 trigger=workspace_open outcome=failed duration=4.21s
  inventories private=12 workspaces=7 complete=3 rows=51 pages=10
  slow workspace-1=3.98s workspace-2=1.20s
  failed stage=shared_inventory status=503 request=req_abc
fl8 outcome=partial duration=820ms before=5 after=3 accepted=2 rejected=1
  updates groups=2 merged=4 bytes=18342 no_progress=no

doc4 note=note-1 scope=workspace-1/room-1 writable=yes age=2m11s
  local_read=18ms/42KB backfill=612ms/9rows/51KB live=offline
  persisted=47 slowest=22ms failures=0 self_heal=0

NETWORK 10m requests=61 failed=2 canceled_expected=4 peak_inflight=9
  db.query/member_notes/select n=19 err=1 p95=1.2s max=4.0s
  realtime.ticket n=4 err=1 p95=820ms max=820ms
burst at=19:13:41 n=38/2s peak=17 top=members.list:21,profiles:11

TIMELINE (newest first, notable only)
+00:00 fs3 failed stage=shared_inventory status=503 req=req_abc
-00:04 workspace-1 socket offline close=1006 hello=yes reconnect=2
-00:07 burst n=38/2s owner=membership-refresh-2
-00:12 fl8 partial content_rejected=1 status=403 req=req_def
-00:31 document doc4 live after=1.4s

CHECK current_page not_run
```

Normal healthy request successes are represented by one `NETWORK` aggregate.
Normal typing does not appear. IDs are internally consistent aliases. The
oldest useful failure and its lead-up survive even if a later sync succeeds.

## Error normalization

Use one normalizer for sync, document, assets, UI actions, and global handlers:

- JS error name/message, truncated;
- Tallpond status/code/requestId;
- safe upstream fields;
- abort classification;
- semantic operation/stage;
- top application stack frame when available.

Capture `window.error` and `unhandledrejection`, but deduplicate against errors
already recorded by operation spans. Production minified stacks alone are not
useful; the build SHA and semantic stage are mandatory. Source maps can remain
non-public or be retained in CI for agent-side symbolication later.

User-facing errors remain short. The report carries the context. A “Sync failed”
notice may add a quiet `Copy diagnostics` action after repeated failure, but
should not expose internal details in the normal interface.

## Instrumentation rules that prevent log vomit

1. **Aggregate expected repetition.** Keystrokes, successful writes, presence
   heartbeats, rows, and realtime changes become counters.
2. **Timeline only transitions/outliers.** Failures, retries, slow spans, bursts,
   mode changes, barriers, and invariant violations are individual records.
3. **One parent operation.** Child network aggregates reference `fs3` rather
   than each producing unrelated prose.
4. **Finite event vocabulary.** Event names and fields are typed and tested.
5. **No arbitrary object serialization.** Ever.
6. **Top-N outliers.** Keep slowest three resources/requests, not every one.
7. **Deduplicate.** Same error fingerprint within 5 seconds increments a repeat
   count instead of adding lines.
8. **Hard caps at every layer.** Field length, records, storage, timeline, and
   final report.
9. **Diagnostics add no normal network calls.** Only the explicit check reads.
10. **Debugging cannot break editing.** Every hook is non-throwing and bounded.

## Implementation plan

### Phase 1 — core recorder and report shell

Files:

- add `src/diagnostics.ts` (typed recorder, spans, counters, retention,
  redaction, report generation);
- add `src/diagnostics.test.ts`;
- add Vite build constants and generated build/SW identity;
- capture boot/lifecycle/global errors/storage availability;
- add hidden Diagnostics sheet and copy fallback;
- migrate the current keyboard debug flag/gesture to the new unlock.

Acceptance:

- report works offline in Safari standalone, Android standalone, and desktop;
- no content/raw IDs in fixture reports;
- report under 8 KB in a representative healthy session and always under 16 KB;
- recorder failures do not affect app behavior;
- previous-boot error survives PWA termination/relaunch.

### Phase 2 — semantic Pad instrumentation

Instrument `sync.ts`, `doc.ts`, `local.ts`, `visualAssets.ts`, and the handful of
sharing UI action boundaries.

Start with operation spans and counters, not network interception:

- reasoned sync transitions;
- full-sync stage timings/counts;
- outbox snapshot/drain result;
- share migration stages/barriers;
- active document local read/backfill/live/persist;
- IndexedDB open/blocked/write failures;
- asset operation outcomes;
- cheap local invariant snapshot.

Acceptance:

- tests reproduce and clearly classify: request storm, stale outbox, content
  403 retention, active backfill abort, full-sync inventory failure, share
  migration interrupted by reload, and IDB blocked startup;
- existing sync behavior and request counts are unchanged when diagnostics are
  enabled or hidden.

### Phase 3 — Tallpond SDK observability hooks

Implement request/realtime observers in Tallpond SDK with exhaustive tests:

- observer callbacks cannot alter control flow or throw into SDK operations;
- no ticket/header/body/row reaches observers;
- physical retries correlate to one logical request;
- socket connect/hello/offline/reconnect/resume/resync/snapshot/dispose visible;
- multiple subscriptions on one scope still report one socket;
- observers add no sockets or requests.

This requires a deliberate SDK package version bump before pushing/publishing.
Upgrade Pad only after the package is available; keep the app working without
hooks for compatibility.

Acceptance:

- a report distinguishes ticket failure, upgrade/close loop, snapshot failure,
  sequence resume, forced resync, and healthy socket;
- request aggregate explains endpoint/table/scope fan-out without values.

### Phase 4 — current-page consistency check

Add local integrity scan and bounded read-only metadata/Yjs comparison.

Acceptance matrix:

- equal;
- expected local-ahead with queued ops;
- suspicious local-ahead without queue;
- remote-ahead/stale live tail;
- both-ahead mergeable divergence;
- missing metadata;
- wrong room/scope;
- offline/auth/permission failure;
- row/byte/time limit reached.

Prove with fake IndexedDB and scripted Tallpond clients that the check performs
no writes, compaction, reconciliation, deletes, or subscription changes.

### Phase 5 — field hardening

- Test on installed iOS PWA, Android PWA, Safari, Chrome, and desktop standalone.
- Exercise airplane mode, background/foreground, killed PWA, account switch in
  another tab, session expiry, gateway 5xx, socket close, role removal, rapid
  note switching, and share migration interruption.
- Paste reports into fresh agent sessions and verify they lead to a concrete
  hypothesis without requesting browser devtools.
- Tune thresholds/report size from actual reports, not intuition.
- Remove any old ad hoc debug overlays and console diagnostics after parity.

## Test strategy

### Unit tests

- ring eviction and seven-day expiry;
- dedupe/repeat counts;
- aggregate percentile buckets/top-N;
- operation nesting and interrupted-operation recovery;
- redaction against adversarial IDs, titles, Markdown, URLs, handles, tokens,
  query values, and error payloads;
- hard byte cap with deterministic truncation priorities;
- report aliases remain consistent;
- localStorage unavailable/quota exceeded;
- wall-clock jump while monotonic duration stays correct;
- invariant classifier;
- Yjs directional diff classifier.

### Integration tests

- scripted full-sync stages with operation-correlated request events;
- retries and later recovery preserve the original failure in history;
- 3,000 synthetic successful requests produce aggregates plus one burst event,
  not 3,000 records;
- rapid navigation aborts backfill and marks it expected;
- realtime socket shared by metadata/doc/presence reports one scope socket;
- service worker/build mismatch visible;
- PWA relaunch reconstructs previous interrupted operation.

### Privacy regression test

Build a fixture containing sentinel secrets in every possible source:

- title and Markdown;
- note/share/room/user IDs;
- handle and display name;
- image path and invite URL;
- OAuth code, realtime ticket, cookies and headers;
- Yjs payload and query filters;
- arbitrary gateway error data.

Generate every report path and assert no sentinel appears. Treat this as a
release-blocking test.

### Performance budget

- ordinary event recording: under 0.2 ms average on a mid-range phone;
- no per-keystroke object retained beyond aggregate increments;
- localStorage persistence no more than once per 2 seconds outside errors;
- no added request/socket/timer in normal operation;
- recorder memory under 100 KB;
- persisted capsule under 48 KB;
- report generation under 50 ms for capped input.

## Explicit non-goals

- Product analytics, usage tracking, crash upload, or a server dashboard.
- Automatically sending diagnostics to Tallpond or any third party.
- Capturing document contents to make debugging easier.
- A full Chrome DevTools replacement.
- Recording every Redux/React/UI action, request, row, Yjs update, or cursor
  movement.
- An always-visible expert mode for normal users.
- Automatically “repairing” inconsistencies discovered by a check.

Repair must remain a separate, explicit product operation. Diagnostics should
first make the failure legible.

## Recommended first cut

Land Phases 1 and 2 together as the useful minimum. Without the always-on core,
future instrumentation has nowhere safe to go; without semantic sync/doc spans,
the core only says that HTTP was slow. Then add the SDK hook rather than growing
an app-local fetch/WebSocket interception layer.

The most valuable initial report fields are:

1. build/SW identity;
2. current sync/doc/socket state;
3. pending count/type/age/routing integrity;
4. full-sync stage and duration;
5. retry history and request IDs;
6. request burst aggregate;
7. active document backfill/live status;
8. share-migration/barrier state;
9. local integrity summary;
10. a 10-minute notable timeline.

That set is small enough to stay readable and broad enough to diagnose the
failure classes Pad has already experienced: blocked IndexedDB, session/account
races, stale inventory during migration, request storms, slow fan-out, aborted
page backfills, rejected outbox writes, and realtime reconnect/snapshot issues.
