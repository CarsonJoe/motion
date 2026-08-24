# Pad architecture — TLDR

Five threads. They are not separate; they collide on the same two assumptions.

**The two assumptions everything breaks:**
1. One device = one user. Nothing is namespaced.
2. Scope is uniform across a subtree. Groups deliberately kills this.

---

## 1. Identity — a live bug, not a feature

No local data is bound to the user who created it.

- **A's queued edits get written into B's account.** The outbox drains against
  whoever is signed in now. Not just mixing — leakage.
- **A's notes never leave B's screen.** Full sync is a union, never a
  replacement, and only shares get pruned.
- **Note-id collisions** LWW-merge two users' notes and Yjs bodies together.

**Fix:** stamp an `ownerId` on the local store. Unset → claim. Match → proceed.
Mismatch → wipe and re-sync. Gate the outbox drain on a confirmed owner. Add
sign-out sharing the same path. Prompt before wiping only if work is pending.

⚠️ The obvious fix (prune anything the server doesn't know about) would eat
every local-only note. Must land aware of §3.

---

## 2. Trash / archive

Soft-delete already exists and replicates correctly. Missing: retention + purge.

- Purge needs an explicit tombstone. Absence can't mean purged — absence already
  means three other things.
- Client-side purge is dangerous: a device offline 60 days would destroy notes
  restored elsewhere. Server-authoritative, or gated well past the window.

**Key insight: trash is the removal signal the other features need.** Making a
note local-only, or leaving a group, lands it in your other devices' trash
instead of vanishing silently. Recoverable, visible, already replicates.

---

## 3. Residency — local-only vs synced

Per-note property enforced at the drain: local-only ops never enter the outbox.

**A local-only note is E2EE for free.** No key distribution, no gateway public
keys, no recovery escrow. Every hard crypto problem exists only because the
server holds data. Ships independent of the Tallpond question.

**Invariants:** subtree-scoped like sharing · a synced note can't have a
local-only ancestor (dangling parent) · shared implies synced · exempt from
server-absence pruning.

**v1:** set-at-creation, one-way toward sync. "Create this local" is most of the
value; "make this local" carries the whole distributed-removal problem.

**Cost:** no backup, no recovery, by design. Must be loud at creation. Plaintext
Markdown export becomes non-optional.

---

## 4. Groups — the biggest change

Data model is ready (`shareId` is already per-note). The *operations* are what
assume uniformity.

**The structural shift:** a note whose parent is unreachable is currently a bug
the invariant prevents. Under groups it's legitimate and unpreventable — a note
shared with a group whose parent is private to someone else.

→ Tree rendering moves from **prevention to resolution**: a visible note whose
parent isn't resolvable for this viewer renders detached at the root.

Knock-ons: `subtreeIds` still means *structure*, no longer *permission* · the
cross-scope move guard narrows to "you lack rights on the destination" ·
**deletion detaches, never cascades** — one user's delete must never reach into
another group's content.

Everything else on this list is easier than this.

---

## 5. Encryption

**The claim:** "in transit" is TLS, "at rest in cloud" is provider-held keys —
everyone has both. The only claim with teeth is **"we can't read your notes."**
Binary, and gated entirely on sharing.

If shares need per-member key wrapping, the gateway must serve per-user public
keys. If Tallpond can't, server-side E2EE is dead for shared notes permanently.
**Decide sharing's crypto story before designing the key hierarchy.** Middle
ground: private notes truly E2EE, shared notes server-encrypted, stated plainly.

**Hierarchy:** random DEK encrypts bodies + titles → KEK from an unlock factor
wraps it → multiple wrappings = multiple unlock methods, no re-encryption. Stub
a per-member wrapping layer now even if never built.

**Biometric:** WebAuthn PRF extension → HKDF → KEK. Passphrase fallback is
mandatory. Support is uneven; feature-detect.

**Phone as 2FA:** already exists — WebAuthn hybrid transport (QR + BLE). Nothing
to build. Open question is whether PRF rides over it.

**Per-note locks:** fresh assertion, not session unlock. Encrypt the title or
it's theater. Relock must drop the Yjs doc and unmount the editor — this is the
part that bites. Sells on a *social* privacy axis, not a breach axis: the real
local threat is someone you know, at your unlocked device. Smallest feature
here, needs neither PRF nor a resolved cloud story.

**Cost:** cold offline start now requires unlock. An encrypted outbox means a
locked-out user has pending changes they can neither see nor send.

---

## Order (dependency-driven)

1. **Identity** — live bug, blocks everything
2. **Trash** — provides the tombstone the next two need
3. **Residency + local E2EE** — the differentiated feature, unblocked
4. **Groups** — largest change
5. **Cloud encryption** — gated on the sharing decision

Per-note locks can jump the queue any time after 3.

---

## Test app (throwaway PWA, 4 screens — not a notes app)

1. **PRF over hybrid transport** across the real device matrix — make-or-break
2. What cold-offline unlock *feels* like
3. Relock correctness — key zeroed, doc dropped, nothing left in a ref
4. Enrollment + recovery — second authenticator, losing the first
