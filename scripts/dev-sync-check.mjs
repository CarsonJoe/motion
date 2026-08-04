// End-to-end transport check against the dev environment: private realtime,
// shared realtime, writer permissions, and membership leave — using the same
// tables the app uses. Requires `tallpond login` and a deployed dev schema
// (`tallpond dev`).
import { execFileSync } from 'node:child_process'
import { createClient } from '@tallpond/sdk'
import * as Y from 'yjs'

const gatewayUrl = process.env.TALLPOND_GATEWAY_URL || 'https://api.tallpond.com'
const session = (user) => {
  const output = execFileSync('npx', ['tallpond', 'test-session', '--env', 'dev', '--user', user, '--json'], { encoding: 'utf8' })
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
  const privateNoteId = crypto.randomUUID()
  const privateUpdateId = crypto.randomUUID()
  let resourceId = null

  try {
    await owner.table('notes').insert({ noteId: privateNoteId, title: 'Transport check', parentId: '', deletedAt: 0, clientUpdatedAt: Date.now() })
    const privateSeen = new Promise((resolve) => {
      const subscription = owner.table('note_updates').select().eq('noteId', privateNoteId).live()
        .on('insert', (row) => { if (row.updateId === privateUpdateId) { subscription.close(); resolve(row) } })
    })
    await owner.table('note_updates').insert({ updateId: privateUpdateId, noteId: privateNoteId, payload: payload('private realtime') })
    await timeout(privateSeen, 'private realtime')

    const resource = await owner.resource.create('shared_notes', { name: 'Motion transport check', visibility: 'members' })
    resourceId = resource.id
    await owner.resource(resourceId).members.invite(writerSession.user_id, { role: 'writer' })
    await writer.resource(resourceId).members.accept()

    const sharedNoteId = crypto.randomUUID()
    await owner.resource(resourceId).table('member_notes').insert({ noteId: sharedNoteId, title: 'Shared transport check', parentId: '', deletedAt: 0, clientUpdatedAt: Date.now() })
    const sharedUpdateId = crypto.randomUUID()
    const sharedSeen = new Promise((resolve) => {
      const subscription = writer.resource(resourceId).table('member_note_updates').select().eq('noteId', sharedNoteId).live()
        .on('insert', (row) => { if (row.updateId === sharedUpdateId) { subscription.close(); resolve(row) } })
    })
    await owner.resource(resourceId).table('member_note_updates').insert({ updateId: sharedUpdateId, noteId: sharedNoteId, payload: payload('shared realtime') })
    await timeout(sharedSeen, 'shared realtime')

    const writerUpdateId = crypto.randomUUID()
    await writer.resource(resourceId).table('member_note_updates').insert({ updateId: writerUpdateId, noteId: sharedNoteId, payload: payload('writer update') })
    const rows = await owner.resource(resourceId).table('member_note_updates').select().eq('updateId', writerUpdateId)
    if (rows.length !== 1) throw new Error('Writer update was not visible to the owner')

    // Soft delete travels as an ordinary metadata update.
    await owner.resource(resourceId).table('member_notes').update({ deletedAt: Date.now(), clientUpdatedAt: Date.now() }).eq('noteId', sharedNoteId)

    await writer.resource(resourceId).members.leave()
    const writerResources = await writer.resource.list({ type: 'shared_notes' })
    if (writerResources.some((candidate) => candidate.id === resourceId)) throw new Error('Left resource remained in the writer membership list')

    console.log('dev sync transport passed: private realtime, shared realtime, writer permissions, soft delete, leave membership')
  } finally {
    await Promise.resolve(owner.table('note_updates').delete().eq('noteId', privateNoteId)).catch(() => {})
    await Promise.resolve(owner.table('notes').delete().eq('noteId', privateNoteId)).catch(() => {})
    if (resourceId) await owner.resource(resourceId).delete().catch(() => {})
  }
}

await run()
