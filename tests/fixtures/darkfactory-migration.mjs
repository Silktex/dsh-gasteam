/** Actual built ingestion/artifact/health/policy owners; no model, network or fixture journal reducer. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { DarkFactoryIngestionStore, DarkFactoryArtifactStore, DarkFactoryPolicyStore, enabledDarkFactoryConfigSchema, digestBytes, digestJson } from '../../packages/agent-team/lib/darkfactory.js'
import { HealthStore } from '../../packages/agent-team/lib/types/health.js'
import { DurableJournal } from '../../packages/agent-team/lib/types/durable-journal.js'

const [mode, directory] = process.argv.slice(2)
if (!directory) throw new Error('Expected migration fixture mode and directory')
const projectId = 'migration-project', migrationId = 'fixture-migration', at = '2026-09-06T12:00:00Z'
const options = { projectId, maxBodyBytes: 4096, maxQueueItems: 10, maxRecordBytes: 65536, maxJournalBytes: 1048576 }
const anchor = join(directory, 'darkfactory', projectId, 'ingestion.jsonl')
// Keep the IPC channel referenced while the second-validation barrier waits for SIGKILL.
process.on('message', () => {})
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
let store, health, authority, validations = 0
const errors = error => [error?.message, error?.cause?.message].filter(Boolean).join(': ')
try {
  if (mode === 'legacy') {
    let journal, failure, reduced = 0
    const before = await readFile(anchor)
    try { journal = await DurableJournal.open(anchor, {}, state => { reduced++; return state }) } catch (error) { failure = errors(error) }
    finally { await journal?.close() }
    assert.ok(failure?.includes('Unsupported version'), 'Legacy parser did not reject the new layout version')
    assert.equal(reduced, 0); assert.deepEqual(await readFile(anchor), before)
    await send({ barrier: 'legacy-refused', pid: process.pid, reduced, reason: failure })
  } else if (mode === 'blocked') {
    let failure
    try { store = await DarkFactoryIngestionStore.open(directory, options) } catch (error) { failure = errors(error) }
    assert.ok(failure?.includes('unsafe or incomplete'), 'Incomplete migration unexpectedly reopened')
    await send({ barrier: 'native-refused', pid: process.pid, reason: failure })
  } else {
    const policy = enabledDarkFactoryConfigSchema.parse(JSON.parse(await readFile(join(directory, 'fixture-policy.json'), 'utf8')))
    const authorizationRef = 'fixture-policy-installation'
    authority = await DarkFactoryPolicyStore.open(directory, { grants: [{ projectId, operatorIds: [policy.ownerId], authorizationRefs: [authorizationRef] }] }, () => at)
    if (mode === 'seed') await authority.installPolicy({ projectId, expectedRevision: 0, operatorId: policy.ownerId, authorizationRef, policy })
    health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
    const artifacts = await DarkFactoryArtifactStore.open(directory, [projectId], 4096, 65536)
    store = await DarkFactoryIngestionStore.open(directory, options, () => at)
    const envelope = async (id, number) => ({ schemaVersion: 1, id, projectId, policyRevision: 1, source: 'github', adapterVersion: 'github-v1', routeId: 'route', deliveryId: `delivery-${number}`,
      eventKind: 'issues', action: 'opened', bodyDigest: digestJson({ rawProviderObservation: number }), receivedAt: at, signingKeyId: 'fixture-key', authentication: 'verified',
      artifact: await artifacts.persist(projectId, { schemaVersion: 1, envelopeId: id, providerEntityId: String(number), sanitized: 'Migration lookup fixture' }) })
    async function validateReferences(snapshot) {
      assert.equal(snapshot.custody.length >= 2, true)
      assert.equal(snapshot.items.length, 1)
      for (const custody of snapshot.custody) {
        assert.equal(custody.envelope.projectId, projectId)
        const persisted = authority.snapshot().find(value => value.projectId === custody.envelope.projectId)?.policies.find(value => value.policyRevision === custody.envelope.policyRevision)
        assert.ok(persisted, 'Missing persisted policy reference')
        assert.equal(persisted.projectId, projectId); assert.equal(digestJson(persisted.policy), persisted.digest)
        assert.ok(persisted.policy.projectIds.includes(projectId))
        const route = persisted.policy.ingestion.routes.find(value => value.id === custody.envelope.routeId && value.projectId === projectId)
        assert.ok(route, 'Missing persisted route reference')
        assert.equal(route.source, custody.envelope.source)
        assert.equal(route.providerVersion, custody.envelope.adapterVersion, 'Persisted adapter reference mismatch')
        assert.equal(route.signingKeyId, custody.envelope.signingKeyId, 'Persisted signing key reference mismatch')
        const reference = custody.envelope.artifact
        const bytes = await readFile(join(directory, 'darkfactory', projectId, 'artifacts', reference.id))
        assert.equal(bytes.length, reference.sizeBytes); assert.equal(digestBytes(bytes), reference.digest)
        assert.equal((await artifacts.read(reference)).envelopeId, custody.envelope.id)
        if (custody.itemId) {
          const item = snapshot.items.find(item => item.id === custody.itemId)
          assert.ok(item); assert.equal(item.envelopeId, custody.envelope.id); assert.equal(item.projectId, projectId)
          assert.equal(item.policyRevision, persisted.policyRevision); assert.equal(item.trust.authorityRevision, persisted.policyRevision)
          assert.ok(route.repositoryIds.includes(item.repository.repositoryId))
          assert.ok(item.provenance.some(value => value.id === reference.id && value.digest === reference.digest))
        }
        if (custody.healthEscalationId) {
          const incident = health.listEscalations().find(value => value.id === custody.healthEscalationId)
          assert.ok(incident); assert.equal(incident.source, 'darkfactory'); assert.equal(incident.projectId, projectId)
          assert.equal(incident.policyRevision, persisted.policyRevision)
          assert.equal(incident.effectId, custody.envelope.id); assert.equal(incident.reason, custody.quarantineReason)
          assert.equal(incident.acknowledgement.actor, 'fixture-lead')
        }
      }
    }
    if (mode === 'seed') {
      const first = await envelope('envelope-1', 1)
      const sourceRevision = digestJson({ entity: '1', revision: 1 })
      const item = { schemaVersion: 1, id: 'work-1', projectId, policyRevision: 1, envelopeId: first.id, source: 'github', sourceEntityId: 'issue-1', sourceRevision,
        repository: { provider: 'github', repositoryId: 'repo-1', canonicalName: 'fixture/repo' }, author: 'fixture-author', actor: 'fixture-actor', title: 'Fixture issue', context: 'Sanitized source context', labels: ['automate'],
        sourceUrl: 'https://github.com/fixture/repo/issues/1', provenance: [first.artifact], trust: { decision: 'unresolved', reasons: ['FIXTURE_PENDING'], checkedAt: at, entityRevision: sourceRevision, authorityRevision: 1 }, state: 'received', revision: 1 }
      await store.recordReceived({ envelope: first, item, bodySizeBytes: 64 })
      await store.transition({ projectId, expectedRevision: 1, item: { ...item, revision: 2, state: 'trusted', trust: { ...item.trust, decision: 'trusted', reasons: ['FIXTURE_AUTHORITY'] } } })
      const second = await envelope('envelope-2', 2)
      const incident = await health.raiseFactoryEscalation({ schemaVersion: 1, projectId, policyRevision: 1, stage: 'ingress', reason: 'SOURCE_DENIED', effectId: second.id,
        evidenceRefs: [second.id], severity: 'warning', diagnostics: 'Fixture source requires review' }, Date.parse(at))
      await store.recordReceived({ envelope: second, bodySizeBytes: 64, quarantineReason: 'SOURCE_DENIED', healthEscalationId: incident.id })
      await health.acknowledge(incident.id, incident.revision, 'fixture-lead', Date.parse(at))
    }
    const before = store.snapshot()
    let result, rejection, referenceFailure
    if (mode === 'migrate-blocked' || mode === 'migrate' || mode === 'migrate-denied') {
      await store.close(); store = undefined
      try { result = await DarkFactoryIngestionStore.migrate(directory, options, { migrationId,
        validateReferences: async snapshot => {
          validations++; assert.deepEqual(snapshot, before)
          try { await validateReferences(snapshot) } catch (error) { referenceFailure = errors(error); throw error }
          if (validations === 2 && mode === 'migrate-blocked') {
            await send({ barrier: 'target-validated', pid: process.pid, validations, ingestion: snapshot, inbox: health.listEscalations(), policies: authority.snapshot() })
            await new Promise(() => {})
          }
        },
      }) } catch (error) { if (mode !== 'migrate-denied') throw error; rejection = errors(error) }
      if (mode === 'migrate-denied') {
        assert.ok(rejection); assert.equal(validations, 1)
        assert.equal(referenceFailure, 'Missing persisted policy reference')
      } else {
        assert.equal(validations, 2)
        store = await DarkFactoryIngestionStore.open(directory, options, () => at)
        assert.deepEqual(store.snapshot(), before)
        assert.ok(!result.backup.startsWith('/proc/')); assert.ok(!result.target.startsWith('/proc/'))
      }
    }
    if (mode === 'append') await store.recordReceived({ envelope: await envelope('envelope-3', 3), bodySizeBytes: 64 })
    if (!rejection) await validateReferences(store.snapshot())
    const snapshot = { barrier: rejection ? 'migration-refused' : mode === 'migrate' ? 'migrated' : 'replayed', pid: process.pid, validations, ingestion: store?.snapshot() ?? before, inbox: health.listEscalations(), policies: authority.snapshot(), ...(result ? { migration: result } : {}), ...(rejection ? { reason: referenceFailure } : {}) }
    await artifacts.settled(); await store?.close(); store = undefined; await health.close(); health = undefined; await authority.close(); authority = undefined
    await send(snapshot)
  }
  await store?.close(); process.disconnect()
} catch (error) {
  await store?.close(); await health?.close(); await authority?.close()
  await send({ barrier: 'error', message: errors(error) }); process.exitCode = 1; process.disconnect()
}
