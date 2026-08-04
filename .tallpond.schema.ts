import { defineSchema } from '@tallpond/schema'

// Motion stores one row of metadata per note and an append-only log of Yjs
// updates per note body. Metadata (title, parent, deletion) is last-write-wins
// by client timestamp; content merges through the CRDT log, so the two never
// share authority. Deletions are soft (`deletedAt`) so a stale device can
// never resurrect a removed note.
export default defineSchema({
  tables: {
    notes: (table) => {
      table.text('noteId').notNull().unique()
      table.text('title').notNull().default('')
      // Empty string means the note sits at the root of the tree.
      table.text('parentId').notNull().default('')
      // 0 means alive. A nonzero value is the client ms timestamp of deletion.
      table.bigint('deletedAt').notNull().default(0)
      table.bigint('clientUpdatedAt').notNull()
      table.timestamps()
      table.index(['noteId'])
      table.index(['parentId'])
    },
    // Immutable Yjs updates. Clients merge and re-insert long logs, then delete
    // the consumed rows — Yjs deduplicates, so concurrent compaction is safe.
    note_updates: (table) => {
      table.uuid('updateId').notNull().unique()
      table.text('noteId').notNull()
      table.text('payload').notNull()
      table.timestamps()
      table.index(['noteId'])
    }
  },
  resources: {
    // One shared resource is one shared root note plus every note nested
    // beneath it. Members see the same two-table model as the private scope;
    // the member_ prefix exists because resource tables share a namespace
    // with top-level tables.
    shared_notes: (resource) => {
      resource.visibility('members')
      resource.defaultRole('reader')
      resource.grant({ owner: 'admin', admin: 'writer', writer: 'reader', reader: null })
      resource.owns('member_notes', (table) => {
        table.text('noteId').notNull().unique()
        table.text('title').notNull().default('')
        table.text('parentId').notNull().default('')
        table.bigint('deletedAt').notNull().default(0)
        table.bigint('clientUpdatedAt').notNull()
        table.timestamps()
        table.index(['noteId'])
        table.index(['parentId'])
        table.access({ read: 'reader', create: 'writer', update: 'writer', delete: 'admin' })
      })
      resource.owns('member_note_updates', (table) => {
        table.uuid('updateId').notNull().unique()
        table.text('noteId').notNull()
        table.text('payload').notNull()
        table.timestamps()
        table.index(['noteId'])
        // Writers may delete: compaction replaces consumed rows with their merge.
        table.access({ read: 'reader', create: 'writer', update: 'none', delete: 'writer' })
      })
      // Ephemeral cursors. Rows expire client-side; nothing here is queued
      // offline or treated as durable.
      resource.owns('member_presence', (table) => {
        table.text('presenceId').notNull().unique()
        table.text('noteId').notNull()
        table.text('displayName').notNull()
        table.jsonb('data').notNull()
        table.bigint('expiresAt').notNull()
        table.timestamps()
        table.index(['noteId'])
        table.access({ read: 'reader', create: 'writer', update: 'writer', delete: 'writer' })
      })
    }
  }
})
