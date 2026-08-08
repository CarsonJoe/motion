# Architecture notes: identity, residency, trash, access, encryption

Status: design notes, nothing implemented. Written 2026-08-07.

Five threads that look separate and are not. They all touch the same two
assumptions in `local.ts` / `sync.ts`, and the order they land in matters
because several of them can destroy data written by the others.

---

## 0. The two assumptions everything collides with

**Assumption A — one device, one user.** Every persistence key is a constant:
`DATABASE_NAME = 'motion'` (`local.ts:59`), `motion-role:*` and
`motion-connected` (`sync.ts:36,50`), `motion-favorites` and
`motion-sidebar-collapsed` (`App.tsx:564,604`). `state.user` is fetched at
`sync.ts:412` and never compared to anything.

**Assumption B — scope is uniform across a subtree.** `moveBlockedBy`
(`local.ts:54`) enforces it as a hard invariant:

```ts
if ((parent?.shareId ?? '') !== note.shareId) return 'scope'
```

`deleteNoteTree`, `shareNoteTree`, and every use of `subtreeIds` depend on it.
`shareNoteTree` goes further and reparents the root to `''` so a shared tree is
always self-contained.

Assumption A is a live correctness bug. Assumption B is the thing the groups
work deliberately removes.

---

## 1. Identity (bug, not a feature)

Nothing binds local data to the user who created it. Three consequences, worst
first:

1. **A's queued edits get written into B's account.** The store opens before any
   session exists and typing schedules a flush independently of auth. When B's
   session establishes, `drainOutbox` (`sync.ts:149`) drains A's leftover ops
   against B's client. For private notes `notesTable(client, '')` is B's own
   table, and `pushNoteRow` (`sync.ts:206`) falls through to `insert` when the
   row is absent. A's note bodies land as B's rows.
2. **A's notes never leave B's screen.** `fullSync` is a union, never a
   replacement. The only pruning is `sharesBefore` → `removeShare`
   (`sync.ts:362`); there is no equivalent for private notes, and nothing on the
   server ever contradicts them.
3. **Note-id collisions.** `notes` is keyed by bare `id`, so `applyRemoteNote`
   LWW-merges across users by `updatedAt`, and `docs` merges two users' Yjs
   states into one body.

### Fix

Not DB-name namespacing (`motion:${userId}`) — the store must open before
identity is known for offline-first startup to work at all. Instead:

- A `meta` store holding `ownerId`. In `establishSession`, once `getUser()`
  resolves, compare: unset → claim (pre-login notes belong to the first user who
  signs in, which is correct); match → proceed; mismatch → reset.
- **Gate `drainOutbox` on a confirmed owner.** `getUser()` is currently fired as
  `void ….then()` and not awaited, so there is a window where `connected: true`
  but the id is unknown and `fullSync` drains inside it.
- Sign-out shares one code path with the mismatch branch. Sign-out with a
  non-empty outbox should block on drain with a visible state, not silently
  discard.
- Prompt before wiping only when `pending > 0`.

> **Collision:** the obvious fix for (2) — prune notes the server doesn't know
> about — would silently eat every local-only note from §3. These two must land
> aware of each other.

---

## 2. Trash / archive

`deletedAt` is already a durable soft-delete that out-votes older rows, so most
of trash exists. What's missing is retention and purge.

- `deletedAt != 0` means "in trash". Restore sets it to `0` with a fresh
  `updatedAt` so LWW carries the restore.
- **Purge is a distinct signal from soft-delete.** Absence can't mean purged —
  absence already collides with §1's pruning and §3's local-only exemption.
  Needs an explicit tombstone.
- **Client-side purge is dangerous.** A device offline for 60 days coming back
  and purging on a local clock will destroy notes restored elsewhere. Purge
  should be server-authoritative, or gated on a successful full sync plus a
  grace margin well beyond the retention window.
- Local-only notes purge locally only; there is no server to authorize it.

### Trash solves the synced→local problem

Making a synced note local-only has to remove it from every *other* device, and
`fullSync` has no signal for a private note that stopped existing. **Route it
through trash instead:** the note lands in the other device's trash rather than
vanishing. Recoverable for 30 days, visible, and it reuses a mechanism that
already replicates correctly. Same trick applies to leaving a group.

---

## 3. Residency (local-only vs synced)

Residency and encryption are one mechanism, enforced at the drain: `local-only`
means ops never enter the outbox and `pushNoteRow` never sees the note.

**A local-only note is E2EE by construction** — no key distribution, no gateway
public keys, no recovery escrow, no ciphertext migration. Every hard problem in
§5 exists only because the server holds data. This ships independent of whether
Tallpond can serve per-user public keys.

### Invariants

1. Residency is subtree-scoped, like sharing and deletion — `subtreeIds` already
   does exactly this for both.
2. **A synced note cannot have a local-only ancestor.** Its `parentId` would
   reference a row the server has never seen: it arrives elsewhere as an orphan
   with a dangling parent. Same shape as the existing cycle guard, same place to
   enforce it.
3. **Shared implies synced.** `shareId != ''` and local-only are contradictory;
   make the option unavailable rather than fail after the fact.
4. Local-only notes are exempt from any server-absence pruning (see §1).

### v1 scope

Consider making residency **set-at-creation and one-way toward sync**. "Create
this local" is most of the value; "make this local" carries the whole
distributed-removal problem in §2. Ship the 90%.

### Loss surface

Local-only + encrypted = no backup and no recovery, by design. Two devices means
two independent copies, neither aware of the other. This has to be loud at
creation, not buried in settings, and it makes a **plaintext Markdown export
path non-optional**. The `markdown.ts` layer already exists for it.

---

## 4. Groups / access control

The data model is mostly ready and the *operations* are what force uniformity.
`Note.shareId` is already per-note, so a child scoped to a different group is
representable today. What changes is that `moveBlockedBy`'s `'scope'` rule,
`shareNoteTree`'s root-reparenting, and `deleteNoteTree`'s subtree sweep all
assume it never happens.

A group maps onto a Tallpond `shared_notes` resource fairly directly — members,
roles via `currentMember.role`, cached in `motion-role:*`.

### The structural change: dangling parents become normal

Today a note whose parent is unreachable is a bug the invariant prevents. With
groups it is a **legitimate, unpreventable state**: a note shared with a group
whose parent is private to someone else. Members of that group can see the child
and must never see the parent.

So the tree renderer needs a general rule — *a visible note whose parent is not
resolvable for this viewer renders at the root as a detached item* — rather than
a guard that prevents every case. This replaces the hard-invariant approach with
a resolution approach, and it is the single biggest change on this list.
Everything else in this document is easier than it.

Knock-on effects:

- `subtreeIds` stops being an authority for sharing and access. It stays correct
  for *structure*; it stops implying *permission*.
- **Deletion detaches, it does not cascade.** Trashing a parent must not trash
  children scoped to a group you don't administer — one user's delete never
  reaches into another group's content. Those children reparent to the root
  (where §4's detached-item rendering already puts them) and stay alive.
- `moveBlockedBy`'s `'scope'` return becomes a much narrower rule (probably only
  "you lack rights on the destination"), and the cycle guard stays as-is.
- Role caching per resource survives unchanged.

### Rules worth defining early

Per-group default role; per-note override; inheritance as opt-in rather than
implicit. Whether a private child under a shared parent is expressible (it
should be — that is half the point).

---

## 5. Encryption

### The claim

"Encrypted in transit" is TLS; everyone has it. "Encrypted at rest in the cloud"
is provider-held keys; everyone has that too. The only claim with teeth is **"we
can't read your notes"**, which is binary and is gated on sharing.

If a share requires wrapping the note key for each member, the gateway must
serve per-user public keys. If Tallpond cannot, server-side E2EE is off the
table for shared notes permanently. **Decide the sharing story before designing
the key hierarchy** — retrofitting a public-key layer is a rewrite; designing
for it and not using it is nearly free.

Defensible middle ground: private notes genuinely E2EE, shared notes
server-encrypted with gateway-held keys, stated plainly.

### Key hierarchy

- **DEK** — random AES-GCM-256, encrypts `docs` payloads and titles.
- **KEK** — derived from an unlock factor, wraps the DEK. Multiple independent
  wrappings of the same DEK = multiple unlock methods without re-encrypting.
- Store only the wrapped DEK. Hold the live DEK as a `CryptoKey` with
  `extractable: false`.
- *(stub)* **Per-member wrapping layer** for group-shared notes — requires
  gateway-served public keys. Design the shape now, build later or never.

Necessarily plaintext: `noteId` (the gateway queries `.eq('noteId', …)`),
`parentId`, `deletedAt`, `updatedAt`.

### Biometric unlock

WebAuthn **PRF extension** with a platform authenticator. Deterministic 32-byte
secret per (credential, salt) → HKDF → KEK. Biometric gates the assertion;
nothing biometric is ever stored.

- PRF support is uneven and moving. Feature-detect at enrollment.
- **Passphrase fallback is mandatory** — PBKDF2/Argon2 wrapping a second copy of
  the same DEK. Authenticators get lost and reset.
- Non-PRF fallback: gate on a successful assertion only. Weaker — an
  authorization check JS could bypass, not cryptography — but still a real
  barrier to the shared-device case.

### Phone as second factor

This is WebAuthn **hybrid transport** (QR + BLE proximity), already in the
platform. Nothing to build. The open question is whether **PRF rides over hybrid
transport** — if yes, phone-gated decryption on a desktop is nearly free; if no,
it degrades to the weak authorization check above.

### Per-note locks

Separate note key wrapped by the DEK, requiring a **fresh** assertion rather
than the session unlock.

- Locked notes render as a title-less placeholder until touched — so the title
  must be encrypted too, or the lock is theater.
- Auto-relock on a timer and on `visibilitychange`; zero the key, don't hide UI.
- **The Yjs doc must be dropped and the editor unmounted on relock.**
  `lexicalBridge` and the doc cache in `App.tsx` currently assume a loaded body
  stays loaded. This is the part that will actually bite.

Note these sell on a different axis than cloud encryption. Cloud encryption is a
breach pitch. Per-note locks are a *social* privacy pitch — the real local threat
is a person you know, standing there, with the device already unlocked. No
at-rest encryption touches that; session relock and a blank placeholder do. It's
also the smallest feature here and needs neither PRF nor a resolved cloud story.

### Cost

Cold start offline requires unlock. Today the app renders instantly with no
session; encrypted-at-rest means a locked offline device shows an unlock screen
before any note is readable. Real regression in the offline-first feel, and the
price of the feature.

The outbox is the sharp edge: it holds unpushed content, so encrypting it means
a user who can't unlock can't drain — correct, but it means "pending changes you
can neither see nor send." Interacts directly with sign-out in §1.

---

## 6. Suggested order

Dependency-driven, not value-driven:

1. **Identity / ownership reset** — a live bug, and it blocks everything.
2. **Trash + retention** — provides the tombstone mechanism §3 and §4 both need.
3. **Residency + local-only E2EE** — consumes trash; independent of the Tallpond
   public-key question; the differentiated feature.
4. **Groups** — needs the dangling-parent redesign, the largest change.
5. **Cloud encryption** — gated on the sharing decision in §5.

Per-note locks (§5) can jump the queue any time after 3; they're self-contained.

---

## 7. Test-app questions

A separate throwaway PWA, four screens, not a notes app. It should answer only
what specs can't:

1. **PRF over hybrid transport** across the real platform matrix (iPhone→Windows,
   iPhone→Mac, Android→Windows). Make-or-break for the phone-as-2FA story.
2. What cold-offline unlock actually *feels* like — a feel question, not a design
   question.
3. Relock correctness: key zeroed, doc dropped, editor unmounted, nothing
   surviving in a React ref.
4. Enrollment and recovery: adding a second authenticator, losing the first, the
   passphrase path.
