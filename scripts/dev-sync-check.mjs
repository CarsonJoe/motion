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
  let roomId = null
  let roomAssetPath = null

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

    // Both sides of membership realtime: the recipient's app-wide feed sees
    // invites/acceptance, while the owner's resource feed sees member changes.
    const writerMembership = writer.resources.live()
    const ownerMembership = owner.resource(resourceId).members.live()
    await Promise.all([
      timeout(new Promise((resolve) => writerMembership.on('status', (status) => { if (status === 'live') resolve() })), 'writer membership connect'),
      timeout(new Promise((resolve) => ownerMembership.on('status', (status) => { if (status === 'live') resolve() })), 'owner membership connect')
    ])
    const inviteSeen = timeout(new Promise((resolve) => writerMembership.on('insert', (row) => {
      if (row.resourceId === resourceId && row.state === 'invited') resolve(row)
    })), 'membership invitation')
    await owner.resource(resourceId).members.invite(writerSession.user_id, { role: 'writer' })
    await inviteSeen

    const acceptanceSeen = timeout(new Promise((resolve) => {
      const accepted = (row) => { if (row.userId === writerSession.user_id && row.state === 'active') resolve(row) }
      ownerMembership.on('insert', accepted).on('update', accepted)
    }), 'membership acceptance')
    const activeSeen = timeout(new Promise((resolve) => {
      const active = (row) => { if (row.resourceId === resourceId && row.state === 'active') resolve(row) }
      writerMembership.on('insert', active).on('update', active)
    }), 'own active membership')
    await writer.resource(resourceId).members.accept()
    await Promise.all([acceptanceSeen, activeSeen])
    writerMembership.close()
    ownerMembership.close()

    const writerRooms = writer.rooms.live()
    await timeout(new Promise((resolve) => writerRooms.on('status', (status) => { if (status === 'live') resolve() })), 'writer room grants connect')

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

    // A room narrows access inside the resource. Metadata and CRDT writes use
    // the same room handle Motion uses for per-note access scopes.
    const privateRoom = await owner.resource(resourceId).rooms.create({ name: 'Motion private note check' })
    roomId = privateRoom.id
    await owner.resource(resourceId).room(roomId).grants.set(ownerSession.user_id, 'admin')
    const roomNoteId = crypto.randomUUID()
    await owner.resource(resourceId).room(roomId).table('member_notes').insert({ noteId: roomNoteId, title: 'Room transport check', parentId: '', deletedAt: 0, clientUpdatedAt: Date.now() })
    roomAssetPath = `notes/${roomNoteId}/${crypto.randomUUID()}.png`
    await owner.resource(resourceId).room(roomId).files('visual_assets').upload(roomAssetPath, new Blob(['room image'], { type: 'image/png' }))

    let deniedBeforeGrant = false
    try { await writer.resource(resourceId).room(roomId).table('member_notes').select().eq('noteId', roomNoteId) }
    catch (error) {
      if (error?.status !== 403) throw error
      deniedBeforeGrant = true
    }
    if (!deniedBeforeGrant) throw new Error('Room note was visible before its grant')
    let assetHiddenBeforeGrant = false
    try { await writer.resource(resourceId).room(roomId).files('visual_assets').download(roomAssetPath, { owner: ownerSession.user_id }) }
    catch (error) {
      if (![403, 404].includes(error?.status)) throw error
      assetHiddenBeforeGrant = true
    }
    if (!assetHiddenBeforeGrant) throw new Error('Room image was visible before its grant')

    const roomGrantSeen = timeout(new Promise((resolve) => writerRooms.on('insert', (grant) => {
      if (grant.resourceId === resourceId && grant.roomId === roomId && grant.role === 'writer') resolve(grant)
    })), 'room grant realtime')
    await owner.resource(resourceId).room(roomId).grants.set(writerSession.user_id, 'writer')
    await roomGrantSeen
    writerRooms.close()
    const roomRows = await writer.resource(resourceId).room(roomId).table('member_notes').select().eq('noteId', roomNoteId)
    if (roomRows.length !== 1) throw new Error('Room note was not visible after its grant')
    const roomAsset = await writer.resource(resourceId).room(roomId).files('visual_assets').download(roomAssetPath, { owner: ownerSession.user_id })
    if (await roomAsset.text() !== 'room image') throw new Error('Room image did not round-trip after its grant')

    // Move a complete note from the default room into the restricted room using
    // the managed row ids, exactly as Motion's resumable subtree move does.
    const movingNoteId = crypto.randomUUID()
    await owner.resource(resourceId).table('member_notes').insert({ noteId: movingNoteId, title: 'Room move check', parentId: '', deletedAt: 0, clientUpdatedAt: Date.now() })
    await owner.resource(resourceId).table('member_note_updates').insert({ updateId: crypto.randomUUID(), noteId: movingNoteId, payload: payload('room move') })
    const [movingMetadata] = await owner.resource(resourceId).table('member_notes').select('id').eq('noteId', movingNoteId)
    const movingUpdates = await owner.resource(resourceId).table('member_note_updates').select('id').eq('noteId', movingNoteId)
    await owner.resource(resourceId).table('member_note_updates').moveRoom(movingUpdates.map((row) => row.id), roomId)
    await owner.resource(resourceId).table('member_notes').moveRoom([movingMetadata.id], roomId)
    const movedRows = await writer.resource(resourceId).room(roomId).table('member_notes').select().eq('noteId', movingNoteId)
    if (movedRows.length !== 1) throw new Error('Moved room note was not visible in its destination')

    // Restoring workspace access targets the default room's managed id, which
    // is distinct from the resource id. Exercise both tables in the reverse
    // direction so an `invalid_room` regression cannot ship again.
    const defaultRoom = (await owner.resource(resourceId).rooms.list()).find((room) => room.isDefault)
    if (!defaultRoom) throw new Error('Resource default room was not listed')
    const [restrictedMetadata] = await owner.resource(resourceId).room(roomId).table('member_notes').select('id').eq('noteId', movingNoteId)
    const restrictedUpdates = await owner.resource(resourceId).room(roomId).table('member_note_updates').select('id').eq('noteId', movingNoteId)
    await owner.resource(resourceId).room(roomId).table('member_note_updates').moveRoom(restrictedUpdates.map((row) => row.id), defaultRoom.id)
    await owner.resource(resourceId).room(roomId).table('member_notes').moveRoom([restrictedMetadata.id], defaultRoom.id)
    const restoredRows = await owner.resource(resourceId).table('member_notes').select().eq('noteId', movingNoteId)
    if (restoredRows.length !== 1) throw new Error('Moved room note did not return to workspace access')

    // Soft delete travels as an ordinary metadata update.
    await owner.resource(resourceId).table('member_notes').update({ deletedAt: Date.now(), clientUpdatedAt: Date.now() }).eq('noteId', sharedNoteId)

    await writer.resource(resourceId).members.leave()
    const writerResources = await writer.resource.list({ type: 'shared_notes' })
    if (writerResources.some((candidate) => candidate.id === resourceId)) throw new Error('Left resource remained in the writer membership list')

    console.log('dev sync transport passed: private realtime, shared realtime, membership realtime, room data/file isolation, writer permissions, soft delete, leave membership')
  } finally {
    await Promise.resolve(owner.table('note_updates').delete().eq('noteId', privateNoteId)).catch(() => {})
    await Promise.resolve(owner.table('notes').delete().eq('noteId', privateNoteId)).catch(() => {})
    // Resource deletion is intentionally not part of the SDK. Empty the test
    // tables so repeated dev checks leave no note data behind; dev resources
    // themselves disappear on the next environment reset.
    if (resourceId) {
      if (roomId) {
        if (roomAssetPath) await Promise.resolve(owner.resource(resourceId).room(roomId).files('visual_assets').delete(roomAssetPath)).catch(() => {})
        await Promise.resolve(owner.resource(resourceId).room(roomId).table('member_note_updates').delete().gte('createdAt', '1970-01-01')).catch(() => {})
        await Promise.resolve(owner.resource(resourceId).room(roomId).table('member_notes').delete().gte('createdAt', '1970-01-01')).catch(() => {})
        await Promise.resolve(owner.resource(resourceId).room(roomId).delete()).catch(() => {})
      }
      await Promise.resolve(owner.resource(resourceId).table('member_note_updates').delete().gte('createdAt', '1970-01-01')).catch(() => {})
      await Promise.resolve(owner.resource(resourceId).table('member_notes').delete().gte('createdAt', '1970-01-01')).catch(() => {})
    }
  }
}

await run()
