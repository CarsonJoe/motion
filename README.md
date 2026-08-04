# Motion

A local-first, Notion-style notes app hosted on [Tallpond](https://tallpond.com).
Works fully offline, syncs durably to the cloud when signed in, and collaborates
in realtime (live edits + presence cursors) on shared pages.

## Architecture

One authority per kind of data — nothing is stored twice:

| Data | Authority | Conflict model |
| --- | --- | --- |
| Note metadata (title, parent, deletion) | `notes` row per note | Last-write-wins by client timestamp |
| Note body (markdown) | Yjs CRDT per note | Automatic merge via `note_updates` log |
| Presence (cursors) | `member_presence` rows | Ephemeral, 30s lease, never queued |

- **Deletes are soft.** `deletedAt` on the metadata row is an ordinary LWW
  update, so a stale device can never resurrect a deleted note.
- **The update log compacts itself.** A writer that loads more than 64 update
  rows inserts their merge and deletes what it consumed. Yjs updates are
  idempotent, so crashes or concurrent compactions are harmless.
- **Sharing is subtree re-homing.** Sharing a page creates a `shared_notes`
  resource, copies the subtree in (rows + one full-state update each), and
  soft-deletes the private rows. Members interact with the same two-table
  model under resource access rules (reader/writer/admin).

### Client modules (`src/`)

- `local.ts` — the single IndexedDB: `notes` (metadata mirror), `docs` (merged
  Yjs state per note), `outbox` (undelivered ops). Fully usable offline;
  everything except the outbox is rebuildable from the server.
- `sync.ts` — session state machine, pull + live subscriptions on the metadata
  tables, serialized outbox drain (content updates merge per note; metadata
  pushes carry an `lte` guard so older rows can never overwrite newer ones),
  sharing/membership/invitations.
- `doc.ts` — per-note document controller: hydrates local state instantly,
  then backfills + live-subscribes the update log. Persist-then-queue ordering
  means a crash loses nothing locally; on every connected open it pushes any
  local-only state the server log is missing (self-healing).
- `codec.ts` — base64 + Yjs helpers, including the minimal-diff markdown
  patcher that keeps concurrent edits mergeable.
- `App.tsx` — the UI, talking only to the modules above.

Offline shell: a hand-rolled service worker (`sw.template.js`, assembled by
`vite.config.ts`) precaches the app shell atomically and never intercepts
gateway requests.

## Development

```sh
npm install
npm test               # vitest: codec, LWW invariants, durability, drain
npm run check          # validate .tallpond.schema.ts locally (no network)
npx tallpond login     # once: device-flow sign-in
npx tallpond dev       # deploy schema to the "dev" environment + test session
npm run test:dev-sync  # end-to-end transport check against the dev environment
npm run dev            # vite (needs VITE_TALLPOND_CLIENT_ID in .env.local)
```

Deploying:

```sh
npm run build
npx tallpond deploy    # schema + functions + ./dist → https://motion-carsongragg.tallpond.app
```

The schema was reset in one clean generation. Legacy tables from earlier
iterations (`pages`, `motion_*`, the `shared_document` resource) are gone from
the schema file; if the gateway flags their removal as a destructive change on
first deploy, reset the dev environment (`npx tallpond env reset dev`) and
confirm the prod migration when prompted — the old data is not read by this
version of the app.
