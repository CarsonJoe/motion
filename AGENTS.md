# Motion

Motion is a local-first notes PWA built with React, TypeScript, Yjs, and Tallpond. Keep the app usable offline and preserve reliable synchronization when changing persistence or network code.

## Git workflow

This project is developed by one user in a single Git repository.

- At the start of every work session, check `git status` and confirm the working tree and branch are up to date with `origin` before making changes. Never discard or overwrite existing local changes; resolve or report them first.
- Keep all normal work on `master`. Do not create or use branches unless the work is explicitly experimental.
- Treat each coherent chunk of work as a separate commit, with a clear commit message. Keep unrelated changes out of the commit.
- Before finishing a chunk, review the diff and verify the relevant tests/checks, then commit it to `master`.

## Development

```sh
npm install
npm test
npm run check
npm run build
npm run dev
```

For Tallpond integration work, use `npx tallpond dev` and `npm run test:dev-sync`. Deployment uses `npx tallpond deploy`.

## Code organization

- `src/App.tsx` — UI and application orchestration
- `src/local.ts` — IndexedDB persistence and offline state
- `src/sync.ts` — authentication, synchronization, subscriptions, and sharing
- `src/doc.ts` — per-note Yjs document lifecycle
- `src/codec.ts` — Yjs/base64 encoding and Markdown conversion/patching
- `src/sw.template.js` — offline app-shell service worker
- `.tallpond.schema.ts` — Tallpond schema

Keep gateway access and sync behavior in the relevant data modules rather than duplicating it in UI components. Preserve offline-first behavior, CRDT mergeability, and persist-before-queue ordering.

## Data model

- Note metadata is stored in `notes`; note bodies are stored as Yjs updates in `note_updates`.
- Metadata uses client-timestamp conflict resolution; body updates merge through Yjs.
- Deletion is represented by metadata rather than immediate disappearance.
- Presence is ephemeral and should not be treated as durable offline data.
- The active schema is `notes`/`note_updates` plus the `shared_notes` resource. Legacy schema declarations are retained for migration compatibility; do not use them for new features.

