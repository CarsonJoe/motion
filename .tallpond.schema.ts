import { defineSchema } from '@tallpond/schema'

export default defineSchema({
  // Private, per-user files are the durable backup transport. Keeping a page in
  // its own JSON file avoids the managed table-query path while preserving
  // incremental, cross-device restores.
  buckets: {
    motion_pages_backup: (bucket) => {
      bucket.maxFileSize('1MB')
      bucket.accept(['application/json'])
    }
  },
  tables: {
    // Preserved for legacy releases; Motion now writes to motion_pages below.
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
    // Native structured storage for Motion. Earlier table versions used a
    // 32-bit integer for JavaScript millisecond timestamps, which overflowed
    // and surfaced as a gateway 500 during normal page edits.
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
    // Page discovery metadata. markdown/yState/blocks are legacy columns kept
    // only for a non-destructive schema transition and are written empty.
    // Immutable motion_crdt_updates are the sole body authority.
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
    // Deletions are durable records, not hard deletes. They prevent a stale
    // device from re-publishing a page after it has been removed elsewhere.
    motion_crdt_tombstones: (table) => {
      table.text('pageId').notNull().unique()
      table.text('deleteRootId').notNull()
      table.uuid('deleteId').notNull().unique()
      table.bigint('deletedAt').notNull()
      table.timestamps()
      table.index(['pageId'])
      table.index(['deleteRootId'])
      table.index(['deletedAt'])
    }
  },
  // A resource is a single shared root page and every nested page below it.
  // There is deliberately no workspace object in the product model.
  resources: {
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
      // Only resource owners/admins may create or update deletion markers.
      // Members can read them so every device can converge on the same tree.
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
      // Immutable Yjs updates are the realtime merge transport. A full Yjs
      // update may be sent again after an offline period; Yjs deduplicates it.
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
      // Compact Markdown-character deltas use a fresh event stream. The
      // legacy document_updates table contained whole-document Lexical states
      // and is intentionally left untouched but no longer read or written.
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
      // Presence is intentionally ephemeral: it is never queued while offline.
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
    }
  }
})
