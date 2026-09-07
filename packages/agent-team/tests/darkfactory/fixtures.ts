import { digestJson, pinExecutableSpec } from '../../src/darkfactory.ts'

export const digest = `sha256:${'a'.repeat(64)}`
export const commit = 'b'.repeat(40)
export const at = '2026-09-06T12:00:00Z'
export const until = '2026-09-06T13:00:00Z'
export const base = { schemaVersion: 1, id: 'record-1', projectId: 'project-1', policyRevision: 1 }
export const artifact = { id: 'artifact-1', projectId: base.projectId, mediaType: 'application/json', sizeBytes: 100, digest }
export const source = { envelopeId: 'envelope-1', source: 'github', sourceEntityId: 'issue-42', sourceRevision: digest }
export const repository = { provider: 'github', repositoryId: 'repo-1', canonicalName: 'example/service' }
export const specPayload = {
  ...base, objective: 'Return the expected status for an empty request', nonGoals: ['No API redesign'],
  invariants: [{ id: 'invariant-1', description: 'Keep the API contract', checkId: 'api-contract' }],
  acceptanceScenarios: [{ id: 'scenario-1', description: 'Reject empty request', fixtureId: 'empty-request', assertionIds: ['status-400'], commandId: 'unit', expected: '400', actual: '500', reproduction: artifact }],
  allowedPaths: ['src/handler.ts'], requiredCapabilities: ['typescript'], risk: 'low', priority: 50,
  source, provenance: [artifact], baseCommit: commit, compilerRevision: 1, promptRevision: 1,
  modelAssignmentId: 'model-assignment-1', policyDigest: digest, rulesDigest: digest, toolchainDigest: digest, workflowDigest: digest,
}
export const spec = pinExecutableSpec(specPayload)
const identity = { ...base, environment: 'staging', releaseId: 'release-1', operationId: 'operation-1', fencingToken: 1, commit, artifactDigest: digest }
const request = { ...identity, protocolVersion: 1, keyId: 'deployment-key', timestamp: at, operation: 'deployCanary', expectedPriorDeployment: 'baseline-1', policyDigest: digest }
const status = { ...identity, protocolVersion: 1, providerRevision: 1, status: 'succeeded', deploymentId: 'deployment-1', requestDigest: digest, observedAt: at }
const critic = {
  ...base, attemptId: 'critic-1', modelAssignmentId: 'model-1', provider: 'fixture', modelVersion: 'fixture-v1',
  contextDigest: digest, specDigest: spec.specDigest, candidateCommit: commit, verdict: 'ACCEPT', confidence: 0.9,
  coveredCriteria: ['scenario-1'], defects: [], committedAt: at,
}
const window = { start: '2026-09-06T11:00:00Z', end: at, requests: 1_000, errors: 0, histogram: artifact, p99Ms: 100 }
const signature = `${'A'.repeat(86)}==`
/** Shape examples, not real signatures or runtime acceptance receipts. */
export const examples = {
  InboundEnvelopeV1: { ...base, source: 'github', adapterVersion: 'github-v1', routeId: 'issues', deliveryId: 'delivery-1', eventKind: 'issues', action: 'opened', bodyDigest: digest, receivedAt: at, signingKeyId: 'github-key', authentication: 'verified', artifact },
  InboundWorkItemV1: { ...base, ...source, repository, author: 'operator', actor: 'operator', title: 'Empty request returns 500', context: 'Observed in the pinned fixture', labels: ['darkfactory:execute'], sourceUrl: 'https://github.com/example/service/issues/42', provenance: [artifact], trust: { decision: 'trusted', reasons: ['allowlisted'], checkedAt: at, entityRevision: digest, authorityRevision: 1 }, state: 'trusted', revision: 1 },
  IngressReceiptV1: { ...base, envelopeId: source.envelopeId, bodyDigest: digest, receivedAt: at, duplicateCount: 0, decision: 'received' },
  ExecutableSpecV1: spec,
  CompilerOutcomeV1: { ...base, source, reasons: ['Reproduction and acceptance checks available'], outcome: 'COMPILED', spec },
  AdmissionReceiptV1: { ...base, source, specId: spec.id, specDigest: spec.specDigest, policyDigest: digest, workflowId: 'workflow-1', workflowDigest: digest, taskIds: ['task-1'], state: 'intended', revision: 1 },
  CriticOutcomeV1: critic,
  VerificationEvidenceV1: { ...base, environment: 'staging', executionMode: 'deploying', taskId: 'task-1', workflowId: 'workflow-1', attemptId: 'attempt-1', generation: 1, sourceCommit: commit, targetCommit: commit, candidateCommit: commit, candidateTreeDigest: digest, specDigest: spec.specDigest, policyDigest: digest, toolchainDigest: digest, stages: ['architecture', 'tests', 'twins', 'mutations', 'critics'].map(stage => ({ id: stage, stage, result: 'PASSED', definitionRevision: 1, startedAt: at, endedAt: at, exitCondition: 'passed', artifacts: [artifact] })), critics: [critic, { ...critic, id: 'critic-2', attemptId: 'critic-2', provider: 'fixture-2' }], createdAt: at, expiresAt: until, decision: 'ACCEPT', signerKeyId: 'signer-1', batchMembers: [], evidenceHash: digest, signature },
  MutantManifestV1: { ...base, attemptId: 'attempt-1', generation: 1, candidateCommit: commit, eligibleCount: 1, selectedCount: 1, selectionRevision: 1, baseline: 'PASSED_TWICE', mutants: [{ id: 'mutant-1', path: 'src/handler.ts', start: 10, end: 20, operatorId: 'boolean-negation', outcome: 'KILLED', repeatedKill: true, artifacts: [artifact] }] },
  DeploymentRequestV1: request,
  DeploymentStatusV1: status,
  DeploymentCallbackV1: { ...base, protocolVersion: 1, keyId: 'deployment-key', timestamp: at, status },
  TelemetryVerdictV1: { ...base, releaseId: 'release-1', deploymentId: 'deployment-1', artifactDigest: digest, policyDigest: digest, queryRevision: 1, baseline: window, sample: window, newestSampleAt: at, collectedAt: at, expiresAt: until, breachCount: 0, result: 'HEALTHY', reasons: ['qualified'], queryArtifacts: [artifact], signerKeyId: 'telemetry-key', attestationHash: digest, signature },
  ReleaseRecordV1: { ...base, repository, environment: 'staging', componentId: 'api', workflowId: 'workflow-1', integrationReceiptId: 'integration-1', attemptIds: ['attempt-1'], specDigests: [spec.specDigest], evidenceHashes: [digest], commit, artifact, priorAcceptedReleaseId: 'baseline-1', priorArtifact: artifact, policyDigest: digest, policySnapshot: artifact, state: 'queued', revision: 1, fencingToken: 1, operationIntents: [], operationReceipts: [], telemetryIds: [] },
  PricingSnapshotV1: { ...base, provider: 'fixture', accountId: 'account-1', modelVersion: 'fixture-v1', currency: 'USD', revision: 1, observedAt: at, expiresAt: until, inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 100_000, outputMicrosPerMillion: 2_000_000, reasoningMicrosPerMillion: 2_000_000, subscriptionFeeMicros: 0, source: artifact },
  ReservationV1: { ...base, fleetId: 'fleet-1', hostId: 'host-1', accountId: 'account-1', attemptId: 'attempt-1', generation: 1, requestId: 'request-1', authorityEpoch: 'epoch-1', fencingToken: 1, pricingRevision: 1, currency: 'USD', maxCostMicros: 10_000, maxTokens: 2_000, maxRequests: 1, quotaPoolIds: ['pool-1'], purpose: 'routine', purposeEvidence: [], createdAt: at, reconcileBy: until, accountingDay: '2026-09-06', accountingMonth: '2026-09', state: 'reserved' },
  UsageEventV1: { ...base, fleetId: 'fleet-1', hostId: 'host-1', attemptId: 'attempt-1', generation: 1, provider: 'fixture', accountId: 'account-1', modelVersion: 'fixture-v1', requestId: 'request-1', streamSequence: 1, pricingRevision: 1, usageAt: at, inputTokens: 100, cacheTokens: 0, outputTokens: 100, reasoningTokens: 0, countingSemantics: 'exclusive-categories', billedCostMicros: 300, currency: 'USD', reservationId: 'reservation-1', eventDigest: digest },
  ProviderQuotaV1: { ...base, fleetId: 'fleet-1', accountId: 'account-1', poolId: 'pool-1', unit: 'tokens', total: 1_000_000, observedRemaining: 500_000, windowStart: at, windowEnd: until, resetAt: until, observedAt: at, expiresAt: until, adapter: 'fixture', adapterVersion: 'v1', source: artifact, authority: 'manual-fixture', watermark: 'usage-1' },
  ModelRoleAssignmentV1: { ...base, attemptId: 'attempt-1', generation: 1, role: 'core-coding', provider: 'fixture', deploymentId: 'fixture-1', modelVersion: 'fixture-v1', catalogRevision: 1, catalogDigest: digest, capabilities: { tools: true, structuredOutput: true, reasoning: true, inputLimit: 64_000, outputLimit: 8_000 }, benchmark: { revision: 1, score: 0.95, evidence: artifact }, health: { observedAt: at, expiresAt: until, p95LatencyMs: 1_000, evidence: artifact }, pricingRevision: 1, fallbackChain: [], quotaDecisionId: 'quota-1', reservationId: 'reservation-1', assignedAt: at },
  OperationalEventV1: { ...base, version: 1, sequence: 1, expectedRecordRevision: 0, recordId: 'release-1', eventKind: 'release-queued', occurredAt: at, severity: 'info', reasonCode: 'INTEGRATION_MERGED', workflowId: 'workflow-1', artifacts: [artifact] },
}
{
  const { evidenceHash: _hash, signature: _signature, ...payload } = examples.VerificationEvidenceV1
  examples.VerificationEvidenceV1.evidenceHash = digestJson(payload)
}
{
  const { attestationHash: _hash, signature: _signature, ...payload } = examples.TelemetryVerdictV1
  examples.TelemetryVerdictV1.attestationHash = digestJson(payload)
}
{
  const { eventDigest: _hash, ...payload } = examples.UsageEventV1
  examples.UsageEventV1.eventDigest = digestJson(payload)
}
