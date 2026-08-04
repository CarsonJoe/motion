import { execFileSync } from 'node:child_process'
import { createClient } from '@tallpond/sdk'
import * as Y from 'yjs'

const gatewayUrl = 'https://api.tallpond.com'
const configHome = new URL('../.tallpond-auth', import.meta.url).pathname
const session = (user) => {
  const output = execFileSync('npx', ['tallpond', 'test-session', '--env', 'dev', '--user', user, '--json'], {
    encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: configHome }
  })
  return JSON.parse(output)
}
const client = (token) => createClient({ gatewayUrl, accessToken: token })
const timeout = (promise, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 10000))
])
const payload = (value) => {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, value)
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

const run = async () => {
  const ownerSession = session('motion_sync_owner')
  const writerSession = session('motion_sync_writer')
  const owner = client(ownerSession.token)
  const writer = client(writerSession.token)
  const privatePageId = crypto.randomUUID()
  const privateUpdateId = crypto.randomUUID()
  let resourceId = null

  try {
    await owner.table('motion_crdt_documents').insert({
      pageId: privatePageId, title: 'Transport check', parentId: '', markdown: '',
      yState: '', blocks: [], clientUpdatedAt: Date.now()
    })
    const privateSeen = new Promise((resolve) => {
      const subscription = owner.table('motion_crdt_updates').select().eq('documentId', privatePageId).live()
        .on('insert', (row) => { if (row.updateId === privateUpdateId) { subscription.close(); resolve(row) } })
    })
    await owner.table('motion_crdt_updates').insert({
      updateId: privateUpdateId, documentId: privatePageId,
      payload: payload('private realtime'), clientUpdatedAt: Date.now()
    })
    await timeout(privateSeen, 'private realtime')

    const resource = await owner.resource.create('shared_document', { name: 'Motion transport check', visibility: 'members' })
    resourceId = resource.id
    await owner.resource(resourceId).members.invite(writerSession.user_id, { role: 'writer' })
    await writer.resource(resourceId).members.accept()

    const sharedPageId = crypto.randomUUID()
    await owner.resource(resourceId).table('shared_pages').insert({
      pageId: sharedPageId, title: 'Shared transport check', parentId: '', markdown: '',
      yState: '', blocks: [], clientUpdatedAt: Date.now()
    })
    const sharedUpdateId = crypto.randomUUID()
    const sharedSeen = new Promise((resolve) => {
      const subscription = writer.resource(resourceId).table('markdown_updates').select().eq('documentId', sharedPageId).live()
        .on('insert', (row) => { if (row.updateId === sharedUpdateId) { subscription.close(); resolve(row) } })
    })
    await owner.resource(resourceId).table('markdown_updates').insert({
      updateId: sharedUpdateId, documentId: sharedPageId,
      payload: payload('shared realtime'), clientUpdatedAt: Date.now()
    })
    await timeout(sharedSeen, 'shared realtime')

    const writerUpdateId = crypto.randomUUID()
    await writer.resource(resourceId).table('markdown_updates').insert({
      updateId: writerUpdateId, documentId: sharedPageId,
      payload: payload('writer update'), clientUpdatedAt: Date.now()
    })
    const rows = await owner.resource(resourceId).table('markdown_updates').select().eq('updateId', writerUpdateId)
    if (rows.length !== 1) throw new Error('Writer update was not visible to the owner')

    await writer.resource(resourceId).members.leave()
    const writerResources = await writer.resource.list({ type: 'shared_document' })
    if (writerResources.some((resource) => resource.id === resourceId)) throw new Error('Left resource remained in the writer membership list')

    console.log('dev sync transport passed: private realtime, shared realtime, writer permissions, leave membership')
  } finally {
    await Promise.resolve(owner.table('motion_crdt_updates').eq('documentId', privatePageId).delete()).catch(() => {})
    await Promise.resolve(owner.table('motion_crdt_documents').eq('pageId', privatePageId).delete()).catch(() => {})
    if (resourceId) await owner.resource(resourceId).delete().catch(() => {})
  }
}

await run()
