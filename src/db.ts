import { addRxPlugin, createRxDatabase, type RxDatabase, type RxCollection } from 'rxdb'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { RxDBMigrationSchemaPlugin } from 'rxdb/plugins/migration-schema'

type LegacyBlock = { id: string; type: 'markdown' | 'paragraph'; data: { text: string } }
export const ROOT_PAGE_ID = ''
// `markdown` is retained for one migration generation as an import seed only.
// Live content is owned by the per-document Y.Text and is never mirrored here.
export type Page = { id: string; title: string; parentId: string; shareId: string; markdown: string; updatedAt: number }
export type LocalTombstone = { id: string; scope: string; pageId: string; deleteRootId: string; deletedAt: number }
export type MotionDatabase = RxDatabase<{ pages: RxCollection<Page>; tombstones: RxCollection<LocalTombstone> }>

addRxPlugin(RxDBMigrationSchemaPlugin)

const pageSchema = {
  title: 'page schema', version: 4, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 60 }, title: { type: 'string' },
    // Dexie can only index required fields. Root pages use an empty string.
    parentId: { type: 'string', maxLength: 60 },
    // Empty means the page is private. A populated value is the Tallpond
    // shared-document resource inherited by this page and its descendants.
    shareId: { type: 'string', maxLength: 60 },
    markdown: { type: 'string' },
    updatedAt: { type: 'number' }
  },
  required: ['id', 'title', 'parentId', 'shareId', 'markdown', 'updatedAt'], indexes: ['parentId', 'shareId', 'updatedAt']
} as const

const tombstoneSchema = {
  title: 'local tombstone schema', version: 0, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 140 },
    scope: { type: 'string', maxLength: 60 },
    pageId: { type: 'string', maxLength: 60 },
    deleteRootId: { type: 'string', maxLength: 60 },
    deletedAt: { type: 'number' }
  },
  required: ['id', 'scope', 'pageId', 'deleteRootId', 'deletedAt'],
  indexes: ['scope', 'pageId', 'deletedAt']
} as const

let databasePromise: Promise<MotionDatabase> | undefined
export function initDatabase() {
  databasePromise ??= (async () => {
    // The module-level promise makes React Strict Mode safe without using
    // RxDB's development-only `ignoreDuplicate` option.
    const db = await createRxDatabase({ name: 'motion_db', storage: getRxStorageDexie(), multiInstance: false })
    await db.addCollections({
      pages: {
        schema: pageSchema,
        migrationStrategies: {
          1: (oldDocument: { parentId?: string | null }) => ({ ...oldDocument, parentId: oldDocument.parentId ?? ROOT_PAGE_ID }),
          2: (oldDocument: { shareId?: string | null }) => ({ ...oldDocument, shareId: oldDocument.shareId ?? '' }),
          3: (oldDocument: { markdown?: string; blocks?: LegacyBlock[] }) => ({ ...oldDocument, markdown: oldDocument.markdown ?? oldDocument.blocks?.[0]?.data.text ?? '' }),
          4: (oldDocument: Page & { blocks?: LegacyBlock[] }) => { const { blocks: _blocks, ...document } = oldDocument; return document }
        }
      },
      tombstones: { schema: tombstoneSchema }
    })
    return db
  })()
  return databasePromise
}
