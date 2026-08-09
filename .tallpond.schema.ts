import { defineSchema } from '@tallpond/schema'

// Motion stores one row of metadata per note and an append-only log of Yjs
// updates per note body. Metadata (title, parent, deletion) is last-write-wins
// by client timestamp; content merges through the CRDT log, so the two never
// share authority. Deletions are soft (`deletedAt`) so a stale device can
// never resurrect a removed note.
export default defineSchema({
  tables: {
    // ---------------------------------------------------------------------
    // Legacy tables from earlier schema generations. The app no longer reads
    // or writes any of these — the current model is `notes` / `note_updates`
    // below and the `shared_notes` resource. They stay declared, unchanged,
    // solely because this platform blocks a deploy that drops a table
    // ("write a custom migration"); removing them here would delete
    // whatever production data still lives in them. Do not add new fields to
    // this app against these tables — extend the live schema instead.
    // ---------------------------------------------------------------------
    pages: (table) => {
      table.text('pageId').notNull().unique()
      table.text('title').notNull()
      table.text('parentId').notNull()
      table.text('blocks').notNull()
      table.integer('clientUpdatedAt').notNull().default(0)
      table.timestamps()
      table.index(['pageId'])
      table.index(['clientUpdatedAt'])
    },
    motion_pages: (table) => {
      table.text('pageId').notNull().unique()
      table.text('title').notNull()
      table.text('parentId').notNull()
      table.text('blocks').notNull()
      table.integer('clientUpdatedAt').notNull().default(0)
      table.timestamps()
      table.index(['pageId'])
      table.index(['clientUpdatedAt'])
    },
    motion_documents: (table) => {
      table.text('pageId').notNull().unique()
      table.text('title').notNull()
      table.text('parentId').notNull()
      table.text('markdown').notNull().default('')
      table.jsonb('blocks').notNull()
      table.bigint('clientUpdatedAt').notNull()
      table.timestamps()
      table.index(['pageId'])
      table.index(['clientUpdatedAt'])
    },
    motion_crdt_documents: (table) => {
      table.text('pageId').notNull().unique()
      table.text('title').notNull()
      table.text('parentId').notNull()
      table.text('markdown').notNull().default('')
      table.text('yState').notNull()
      table.jsonb('blocks').notNull()
      table.bigint('clientUpdatedAt').notNull()
      table.timestamps()
      table.index(['pageId'])
      table.index(['parentId'])
      table.index(['clientUpdatedAt'])
    },
    motion_crdt_updates: (table) => {
      table.uuid('updateId').notNull().unique()
      table.text('documentId').notNull()
      table.text('payload').notNull()
      table.bigint('clientUpdatedAt').notNull()
      table.timestamps()
      table.index(['documentId'])
      table.index(['clientUpdatedAt'])
    },
    motion_crdt_tombstones: (table) => {
      table.text('pageId').notNull().unique()
      table.text('deleteRootId').notNull()
      table.uuid('deleteId').notNull().unique()
      table.bigint('deletedAt').notNull()
      table.timestamps()
      table.index(['pageId'])
      table.index(['deleteRootId'])
      table.index(['deletedAt'])
    },
    // ---------------------------------------------------------------------
    // Live schema.
    // ---------------------------------------------------------------------
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
    // Legacy resource type from an earlier schema generation. Unused by the
    // app; kept declared for the same reason as the legacy tables above —
    // dropping a resource type is a destructive migration on this platform.
    shared_document: (document) => {
      document.visibility('members')
      document.defaultRole('reader')
      document.grant({ owner: 'admin', admin: 'writer', writer: 'reader', reader: null })
      document.owns('shared_pages', (table) => {
        table.text('pageId').notNull().unique()
        table.text('parentId').notNull()
        table.text('title').notNull()
        table.text('markdown').notNull().default('')
        table.text('yState').notNull()
        table.jsonb('blocks').notNull()
        table.bigint('clientUpdatedAt').notNull()
        table.timestamps()
        table.index(['pageId'])
        table.index(['parentId'])
        table.index(['clientUpdatedAt'])
        table.access({ read: 'reader', create: 'writer', update: 'writer', delete: 'admin' })
      })
      document.owns('page_tombstones', (table) => {
        table.text('pageId').notNull().unique()
        table.text('deleteRootId').notNull()
        table.uuid('deleteId').notNull().unique()
        table.bigint('deletedAt').notNull()
        table.timestamps()
        table.index(['pageId'])
        table.index(['deleteRootId'])
        table.index(['deletedAt'])
        table.access({ read: 'reader', create: 'admin', update: 'admin', delete: 'admin' })
      })
      document.owns('document_updates', (table) => {
        table.uuid('updateId').notNull().unique()
        table.text('documentId').notNull()
        table.text('payload').notNull()
        table.bigint('clientUpdatedAt').notNull()
        table.timestamps()
        table.index(['documentId'])
        table.index(['clientUpdatedAt'])
        table.index(['createdAt'])
        table.access({ read: 'reader', create: 'writer', update: 'none', delete: 'admin' })
      })
      document.owns('markdown_updates', (table) => {
        table.uuid('updateId').notNull().unique()
        table.text('documentId').notNull()
        table.text('payload').notNull()
        table.bigint('clientUpdatedAt').notNull()
        table.timestamps()
        table.index(['documentId'])
        table.index(['clientUpdatedAt'])
        table.access({ read: 'reader', create: 'writer', update: 'none', delete: 'admin' })
      })
      document.owns('presence', (table) => {
        table.text('presenceId').notNull().unique()
        table.text('documentId').notNull()
        table.text('displayName').notNull()
        table.jsonb('selection').notNull()
        table.bigint('expiresAt').notNull()
        table.timestamps()
        table.index(['documentId'])
        table.index(['expiresAt'])
        table.access({ read: 'reader', create: 'writer', update: 'writer', delete: 'writer' })
      })
    },
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
