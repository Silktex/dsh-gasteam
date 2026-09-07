import { canonicalJson, digestBytes, digestJson } from '../../src/darkfactory/json.ts'
import { pinExecutableSpec } from '../../src/darkfactory/contracts/spec.ts'
import { verificationReferenceGraphInputSchema, type VerificationReferenceGraphDefinition } from '../../src/darkfactory/contracts/verification-reference-graph.ts'
import { enabledDarkFactoryConfigSchema } from '../../src/darkfactory/config.ts'
import { pinWorkflowDefinition } from '../../src/workflows.ts'
import { darkFactoryTemplate } from '../../src/workflow-templates.ts'
import { policy } from './config-fixture.ts'
import { examples, repository, specPayload } from './fixtures.ts'
import type { GraphArtifactDescriptor } from '../../src/darkfactory/contracts/graph-core.ts'
import { createPublicKey } from 'node:crypto'

/** Synthetic closed snapshots; signatures deliberately are not cryptographic qualifications. */
export function verificationReferenceGraphFixture() {
  const projectId = 'project-1', artifacts: GraphArtifactDescriptor[] = []
  const artifact = (id: string, value: unknown) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : canonicalJson(value))
    const digest = digestBytes(bytes), existing = artifacts.find(item => item.reference.digest === digest)
    if (existing) return existing.reference
    const reference = { id, projectId, digest, sizeBytes: bytes.length, mediaType: 'application/json' }
    artifacts.push({ reference, bytesBase64: bytes.toString('base64') }); return reference
  }
  const base = { schemaVersion: 1 as const, projectId, policyRevision: 1 }, from = '2026-09-06T10:00:00Z', until = '2026-09-06T14:00:00Z'
  const commit = 'c'.repeat(40), sourceCommit = 'b'.repeat(40), targetCommit = 'a'.repeat(40), priorCommit = 'd'.repeat(40)
  const log = artifact('stage-log', 'registered fixture logs'), context1 = artifact('context-1', 'independent context one'), context2 = artifact('context-2', 'independent context two')
  const rules = artifact('rules', { id: 'rules', revision: 1 }), toolchain = artifact('toolchain', { typescript: 'fixture-pinned', revision: 1 })
  const candidateTree = artifact('candidate-tree', { files: ['src/handler.ts'], content: 'fixture candidate' })
  const deployedArtifact = artifact('build', 'immutable built artifact'), priorArtifact = artifact('prior-build', 'immutable prior artifact')
  const workflow = pinWorkflowDefinition(darkFactoryTemplate, { subject: 'fixture repair' })
  const initialPolicy = policy()
  const config = enabledDarkFactoryConfigSchema.parse({ ...initialPolicy, mode: 'staging', projectIds: [projectId],
    ingestion: { ...initialPolicy.ingestion, routes: initialPolicy.ingestion.routes.map(route => ({ ...route, projectId })) },
    fleet: { ...initialPolicy.fleet, projectCaps: initialPolicy.fleet.projectCaps.map(value => ({ ...value, id: projectId })) },
    verification: { ...initialPolicy.verification, checkIds: ['api-contract'], fixtureIds: ['empty-request'], commands: [{ id: 'unit', executable: 'node', args: ['--test'], deadlineMs: 1000 }] },
    delivery: { enabled: true, environments: [{ id: 'staging', projectId, componentIds: ['api'], publicationGrantRefs: ['service-grant'] }],
      adapter: { endpoint: 'https://deployment.example/adapter', version: 'v1', keyId: 'deployment-key', secretRef: { kind: 'env', name: 'DF_DEPLOYMENT_KEY' } },
      artifactBuilder: { id: 'build', executable: 'node', args: ['build.js'], deadlineMs: 1000 }, deadlines: { requestMs: 1000, completionMs: 10000, maxSubmissions: 3 },
      canary: { trafficFraction: 0.05, baselineWindowMs: 900000, pollIntervalMs: 60000, sampleWindowMs: 60000, minRequestsPerWindow: 100, minTotalRequests: 1000, freshnessMs: 120000,
        absoluteErrorRate: 0.01, relativeErrorIncrease: 0.25, minimumErrorIncrease: 0.002, absoluteP99Ms: 1000, relativeP99Increase: 0.25, minimumP99IncreaseMs: 100,
        consecutiveBreaches: 3, observationWindows: 15, observationDeadlineMs: 1800000, promotionWindows: 5, promotionDeadlineMs: 600000 },
      rollback: { enabled: true, immutablePriorArtifactRequired: true, deadlineMs: 10000, verificationCheckIds: ['api-contract'] },
      telemetry: [{ id: 'requests', endpoint: 'https://metrics.example/api', query: 'fixture_requests{project="project-1"}', keyId: 'telemetry-key', secretRef: { kind: 'env', name: 'DF_TELEMETRY_KEY' } }] },
  })
  const policySnapshot = artifact('policy-snapshot', config)
  const spec = pinExecutableSpec({ ...specPayload, id: 'spec-1', policyDigest: policySnapshot.digest, rulesDigest: rules.digest, toolchainDigest: toolchain.digest,
    workflowDigest: digestJson(workflow), provenance: [log], acceptanceScenarios: specPayload.acceptanceScenarios.map(item => ({ ...item, reproduction: log })) })
  const definitions: unknown[] = []
  const register = (kind: VerificationReferenceGraphDefinition['kind'], id: string, payload: object) => {
    const entry = { ...base, kind, id, revision: 1, ...payload }; definitions.push({ ...entry, digest: digestJson(entry) })
  }
  register('spec', spec.id, { spec })
  register('policy', 'policy', { policy: config, snapshot: policySnapshot })
  register('workflow', 'workflow-1', { definition: workflow, taskIds: ['task-1', 'critic-task-1', 'critic-task-2'] })
  for (const id of ['task-1', 'critic-task-1', 'critic-task-2']) register('task', id, { workflowId: 'workflow-1', stepId: id === 'task-1' ? 'implement' : 'verify', specDigest: spec.specDigest, subject: 'Registered work' })
  const attempt = { generation: 1, specDigest: spec.specDigest, sourceCommit, targetCommit, candidateCommit: commit, candidateTreeDigest: candidateTree.digest }
  register('attempt', 'attempt-1', { ...attempt, taskId: 'task-1', role: 'worker' })
  const catalog = artifact('catalog', { revision: 1, models: [{ provider: 'model-provider-1', modelVersion: 'v1' }, { provider: 'model-provider-2', modelVersion: 'v2' }] })
  const critics = [context1, context2].map((context, index) => {
    const n = index + 1, attemptId = `critic-attempt-${n}`, modelAssignmentId = `model-${n}`, provider = `model-provider-${n}`, modelVersion = `v${n}`
    register('attempt', attemptId, { ...attempt, taskId: `critic-task-${n}`, role: 'critic', context, modelAssignmentId })
    register('model-assignment', modelAssignmentId, { attemptId, generation: 1, provider, modelVersion, catalogRevision: 1, catalog })
    return { ...examples.CriticOutcomeV1, ...base, id: `critic-${n}`, attemptId, modelAssignmentId, provider, modelVersion, contextDigest: context.digest,
      specDigest: spec.specDigest, candidateCommit: commit, committedAt: '2026-09-06T11:59:00Z', coveredCriteria: ['scenario-1', 'invariant-1'] }
  })
  const manifest = { ...examples.MutantManifestV1, ...base, id: 'mutant-manifest', candidateCommit: commit,
    mutants: examples.MutantManifestV1.mutants.map(mutant => ({ ...mutant, artifacts: [log] })) }
  const manifestArtifact = artifact('mutant-manifest-bytes', manifest)
  const stageResults = (['architecture', 'tests', 'twins', 'mutations', 'critics'] as const).map(stage => {
    register('verification-stage', stage, { stage, toolchainDigest: toolchain.digest, definition: artifact(`${stage}-definition`, { stage, revision: 1, toolchainDigest: toolchain.digest, exitConditions: ['passed'], checkIds: ['api-contract'], commandIds: ['unit'], fixtureIds: ['empty-request'] }), exitConditions: ['passed'] })
    return { id: stage, stage, result: 'PASSED', definitionRevision: 1, startedAt: '2026-09-06T11:59:00Z', endedAt: '2026-09-06T11:59:00Z', exitCondition: 'passed', artifacts: stage === 'mutations' ? [manifestArtifact] : [log] }
  })
  const unsignedEvidence = { ...examples.VerificationEvidenceV1, ...base, id: 'evidence-1', sourceCommit, targetCommit, candidateCommit: commit, candidateTreeDigest: candidateTree.digest,
    specDigest: spec.specDigest, policyDigest: policySnapshot.digest, toolchainDigest: toolchain.digest, critics, stages: stageResults, signerKeyId: 'signer' }
  const { evidenceHash: _hash, signature: _signature, ...evidencePayload } = unsignedEvidence
  const evidence = { ...evidencePayload, evidenceHash: digestJson(evidencePayload), signature: examples.VerificationEvidenceV1.signature }
  register('integration', 'integration-1', { repository, workflowId: 'workflow-1', taskIds: ['task-1'], attemptIds: ['attempt-1'], specDigests: [spec.specDigest], evidenceHashes: [evidence.evidenceHash],
    sourceCommits: [sourceCommit], targetCommit, candidateCommit: commit, candidateTreeDigest: candidateTree.digest, commit, artifact: deployedArtifact,
    buildRecipe: artifact('build-recipe', { candidateCommit: commit, candidateTreeDigest: candidateTree.digest, artifactDigest: deployedArtifact.digest, toolchainDigest: toolchain.digest, commandId: 'build', commandDigest: digestJson(config.delivery.enabled ? config.delivery.artifactBuilder : null) }), completedAt: '2026-09-06T12:01:00Z' })
  const publicKey = config.verification.trustedPublicKeys[0]!.publicKey
  const telemetryPublicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, 2)]), type: 'spki', format: 'der' }).export({ type: 'spki', format: 'pem' }).toString()
  for (const [id, purpose] of [['signer', 'verification'], ['telemetry-key', 'telemetry']] as const) register('key', id, { environment: 'staging', purposes: [purpose], algorithm: 'ed25519', publicKey: purpose === 'telemetry' ? telemetryPublicKey : publicKey, validFrom: from, validUntil: until })
  register('key', 'deployment-key', { environment: 'staging', purposes: ['deployment-request', 'deployment-callback'], algorithm: 'hmac-sha256', secretRef: { kind: 'env', name: 'DF_DEPLOYMENT_KEY' }, validFrom: from, validUntil: until })
  register('deployment-adapter', 'adapter', { environment: 'staging', endpoint: 'https://deployment.example/adapter', adapterVersion: 'v1', requestKeyId: 'deployment-key', callbackKeyId: 'deployment-key',
    capabilities: { idempotency: true, statusLookup: true, reverseDeployment: true }, qualification: artifact('adapter-qualification', { adapterVersion: 'v1', endpoint: 'https://deployment.example/adapter', capabilities: { idempotency: true, statusLookup: true, reverseDeployment: true }, verifiedAt: from }) })
  const queries = [{ id: 'requests', query: 'fixture_requests{project="project-1"}' }]
  register('telemetry-query', 'query', { environment: 'staging', endpoint: 'https://metrics.example/api', queryRevision: 1, signerKeyId: 'telemetry-key', queries, definition: artifact('query-definition', { queryRevision: 1, queries }) })
  register('imported-baseline', 'baseline-1', { environment: 'staging', componentId: 'api', repository, commit: priorCommit, artifact: priorArtifact, deploymentId: 'stable-deployment', acceptedAt: '2026-09-06T11:00:00Z',
    authorization: artifact('baseline-authorization', { projectId, environment: 'staging', componentId: 'api', repository, releaseId: 'baseline-1', commit: priorCommit, artifactDigest: priorArtifact.digest, deploymentId: 'stable-deployment', actor: 'operator', authorizedAt: from }),
    providerStatus: artifact('baseline-status', { deploymentId: 'stable-deployment', commit: priorCommit, artifactDigest: priorArtifact.digest, status: 'succeeded', observedAt: from }),
    qualifyingHealth: artifact('baseline-health', { deploymentId: 'stable-deployment', artifactDigest: priorArtifact.digest, result: 'HEALTHY', observedAt: from }) })
  const requests = (['deployCanary', 'promote'] as const).map((operation, index) => ({ ...examples.DeploymentRequestV1, ...base, id: `request-${index}`, operationId: `operation-${index}`, operation,
    commit, artifactDigest: deployedArtifact.digest, policyDigest: policySnapshot.digest, expectedPriorDeployment: index ? 'canary-deployment' : 'stable-deployment', timestamp: index ? '2026-09-06T12:20:00Z' : '2026-09-06T12:02:00Z' }))
  const statuses = requests.map((request, index) => ({ ...examples.DeploymentStatusV1, ...base, id: `status-${index}`, operationId: request.operationId, commit, artifactDigest: deployedArtifact.digest,
    deploymentId: index ? 'promoted-deployment' : 'canary-deployment', requestDigest: digestJson(request), observedAt: request.timestamp }))
  const callbacks = statuses.map((status, index) => ({ ...examples.DeploymentCallbackV1, ...base, id: `callback-${index}`, status, timestamp: status.observedAt }))
  const telemetryPayload = { ...examples.TelemetryVerdictV1, ...base, id: 'telemetry-1', deploymentId: 'promoted-deployment', artifactDigest: deployedArtifact.digest, policyDigest: policySnapshot.digest,
    baseline: { start: '2026-09-06T11:45:00Z', end: '2026-09-06T12:00:00Z', requests: 1000, errors: 0, histogram: log, p99Ms: 100 },
    sample: { start: '2026-09-06T12:21:00Z', end: '2026-09-06T12:26:00Z', requests: 1000, errors: 0, histogram: log, p99Ms: 100 },
    newestSampleAt: '2026-09-06T12:26:00Z', collectedAt: '2026-09-06T12:26:01Z', queryArtifacts: [log] }
  const { attestationHash: _attestation, signature: _telemetrySignature, ...telemetryUnsigned } = telemetryPayload
  const telemetry = { ...telemetryUnsigned, attestationHash: digestJson(telemetryUnsigned), signature: examples.TelemetryVerdictV1.signature }
  const release = { ...examples.ReleaseRecordV1, ...base, id: 'release-1', commit, artifact: deployedArtifact, priorArtifact, specDigests: [spec.specDigest], evidenceHashes: [evidence.evidenceHash],
    policyDigest: policySnapshot.digest, policySnapshot, state: 'accepted', revision: 4, operationIntents: requests, operationReceipts: statuses, telemetryIds: [telemetry.id],
    canaryStartedAt: '2026-09-06T12:02:00Z', canaryDeadline: '2026-09-06T12:32:00Z', promotionDeadline: '2026-09-06T12:42:00Z' }
  const records = [
    ...critics.map(value => ({ kind: 'CriticOutcomeV1', value })), { kind: 'VerificationEvidenceV1', value: evidence }, { kind: 'MutantManifestV1', value: manifest },
    { kind: 'ReleaseRecordV1', value: release }, ...requests.map(value => ({ kind: 'DeploymentRequestV1', value })), ...statuses.map(value => ({ kind: 'DeploymentStatusV1', value })),
    ...callbacks.map(value => ({ kind: 'DeploymentCallbackV1', value })), { kind: 'TelemetryVerdictV1', value: telemetry },
  ]
  return verificationReferenceGraphInputSchema.parse({ schemaVersion: 1, lane: 'verification-release', projectId, policyRevision: 1, records, definitions, artifacts })
}
