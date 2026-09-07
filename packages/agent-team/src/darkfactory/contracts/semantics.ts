import type z from 'zod'
import type { contracts } from './index.ts'
import { verifyExecutableSpec } from './spec.ts'
import { digestJson } from '../json.ts'

export type ContractArguments = {
  [K in keyof typeof contracts]: [K, z.output<(typeof contracts)[K]>]
}[keyof typeof contracts]

function require(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function unique(values: readonly string[], label: string): void {
  require(new Set(values).size === values.length, `Duplicate ${label}`)
}
/** Compare RFC 3339 UTC timestamps without dropping sub-millisecond precision. */
function compareTime(a: string, b: string): number {
  const [secondsA, fractionA = ''] = a.slice(0, -1).split('.')
  const [secondsB, fractionB = ''] = b.slice(0, -1).split('.')
  if (secondsA !== secondsB) return secondsA! < secondsB! ? -1 : 1
  const length = Math.max(fractionA.length, fractionB.length)
  const x = fractionA.padEnd(length, '0'), y = fractionB.padEnd(length, '0')
  return x === y ? 0 : x < y ? -1 : 1
}
function ordered(start: string, end: string, label: string, equal = false): void {
  require(equal ? compareTime(start, end) <= 0 : compareTime(start, end) < 0, `Invalid ${label} time order`)
}
function assertProjectBinding(value: unknown, projectId: string, policyRevision: number): void {
  if (typeof value !== 'object' || value === null) return
  if ('projectId' in value) require(value.projectId === projectId, 'Cross-project reference')
  if ('policyRevision' in value) require(value.policyRevision === policyRevision, 'Mismatched referenced policy revision')
  for (const nested of Object.values(value)) assertProjectBinding(nested, projectId, policyRevision)
}

/** Call through validateContract: values must pass their strict shape schema first.
 * These checks prove internal consistency only. External references, registration,
 * signatures, policy decisions and state-owner authority remain runtime checks.
 */
export function assertContractSemantics(...[name, record]: ContractArguments): void {
  assertProjectBinding(record, record.projectId, record.policyRevision)
  switch (name) {
    case 'InboundEnvelopeV1':
      require(record.authentication !== 'host-scanner' || record.source === 'maintenance', 'Host scanner authentication requires maintenance source')
      if (record.authentication === 'provider-api') {
        require(record.source === 'github' && record.bodyDigest === record.artifact.digest, 'Provider-read custody requires exact canonical observation digest')
        ordered(record.providerRead.observedAt, record.receivedAt, 'provider observation', true)
      }
      break
    case 'InboundWorkItemV1':
      if (record.initiator) require(record.source === 'github' && record.actor === record.initiator.scannerId, 'Scanner initiator must be the explicit host actor')
      require(record.trust.entityRevision === record.sourceRevision, 'Trust references a different source revision')
      if (record.state !== 'received' && record.state !== 'quarantined') require(record.trust.decision === 'trusted', 'Ingress lifecycle requires trusted authority')
      if (record.state === 'quarantined') require(!!record.quarantineReason && !!record.healthEscalationId, 'Quarantine requires a reason and health inbox reference')
      break
    case 'ExecutableSpecV1':
      verifyExecutableSpec(record)
      unique(record.allowedPaths, 'allowed path')
      break
    case 'CompilerOutcomeV1':
      if (record.outcome === 'COMPILED') {
        verifyExecutableSpec(record.spec)
        for (const key of ['envelopeId', 'source', 'sourceEntityId', 'sourceRevision'] as const) require(record.source[key] === record.spec.source[key], 'Compiler outcome source mismatch')
      }
      break
    case 'CriticOutcomeV1':
      if (record.verdict === 'ACCEPT') require(!record.defects.some(defect => defect.severity === 'HIGH' || defect.severity === 'CRITICAL'), 'Accepting critic contains blocking defects')
      break
    case 'VerificationEvidenceV1':
      { const { evidenceHash, signature: _signature, ...payload } = record; require(evidenceHash === digestJson(payload), 'Evidence hash mismatch') }
      if (record.diversityDeficit) require(record.executionMode === 'non-deploying-qualification', 'Diversity deficit is restricted to non-deploying qualification')
      ordered(record.createdAt, record.expiresAt, 'evidence expiry')
      unique(record.stages.map(stage => stage.id), 'stage ID')
      unique(record.stages.map(stage => stage.stage), 'stage kind')
      unique(record.critics.map(critic => critic.id), 'critic ID')
      unique(record.critics.map(critic => critic.attemptId), 'critic attempt')
      unique(record.batchMembers.map(member => member.taskId), 'batch task')
      for (const [index, stage] of record.stages.entries()) {
        require(stage.stage === ['architecture', 'tests', 'twins', 'mutations', 'critics'][index], 'Invalid verification stage order')
        ordered(stage.startedAt, stage.endedAt, 'stage', true)
        ordered(stage.endedAt, record.createdAt, 'evidence stage creation', true)
        if (index > 0) ordered(record.stages[index - 1]!.endedAt, stage.startedAt, 'sequential verification stages', true)
      }
      for (const critic of record.critics) {
        assertContractSemantics('CriticOutcomeV1', critic)
        require(critic.specDigest === record.specDigest && critic.candidateCommit === record.candidateCommit, 'Critic candidate/spec mismatch')
        ordered(critic.committedAt, record.createdAt, 'critic commitment', true)
      }
      if (record.decision === 'ACCEPT') {
        // A runtime gate must substantiate twins/mutation applicability against the pinned spec and policy.
        require(record.stages.length === 5 && record.stages.every(stage => stage.result === 'PASSED' || ((stage.stage === 'twins' || stage.stage === 'mutations') && stage.result === 'NOT_APPLICABLE')), 'Accepted evidence requires all verification stages')
        require(record.critics.length === 2 && record.critics.every(critic => critic.verdict === 'ACCEPT'), 'Accepted evidence requires two accepting critics')
        require(record.critics.every(critic => critic.confidence >= 0.8), 'Accepted evidence requires critic confidence of at least 0.8')
        const [first, second] = record.critics
        const diverse = first!.provider !== second!.provider || first!.modelVersion !== second!.modelVersion
        require(diverse || (record.executionMode === 'non-deploying-qualification' && !!record.diversityDeficit), 'Accepted evidence requires critic model/provider diversity or a recorded non-deploying qualification deficit')
      }
      break
    case 'MutantManifestV1':
      require(record.selectedCount === record.mutants.length && record.selectedCount <= record.eligibleCount, 'Inconsistent mutant counts')
      unique(record.mutants.map(mutant => mutant.id), 'mutant ID')
      for (const mutant of record.mutants) {
        require(mutant.start < mutant.end, 'Invalid mutant source range')
        require(!mutant.repeatedKill || mutant.outcome === 'KILLED', 'Repeated kill requires killed mutant')
      }
      break
    case 'DeploymentStatusV1':
      if (record.status === 'succeeded') require(!!record.deploymentId, 'Successful deployment requires deployment identity')
      break
    case 'DeploymentCallbackV1':
      assertContractSemantics('DeploymentStatusV1', record.status)
      ordered(record.status.observedAt, record.timestamp, 'callback observation', true)
      break
    case 'TelemetryVerdictV1':
      { const { attestationHash, signature: _signature, ...payload } = record; require(attestationHash === digestJson(payload), 'Telemetry attestation hash mismatch') }
      for (const window of [record.baseline, record.sample]) {
        ordered(window.start, window.end, 'telemetry window')
        ordered(window.end, record.collectedAt, 'collected window', true)
        require(window.errors <= window.requests, 'Telemetry errors exceed requests')
        require(window.p99Ms === null || !!window.histogram, 'Latency requires a histogram reference')
      }
      ordered(record.sample.start, record.newestSampleAt, 'sample freshness start', true)
      ordered(record.newestSampleAt, record.sample.end, 'sample freshness end', true)
      ordered(record.collectedAt, record.expiresAt, 'telemetry expiry')
      if (record.result === 'HEALTHY') require(record.sample.requests > 0 && record.baseline.requests > 0 && record.sample.p99Ms !== null && record.baseline.p99Ms !== null, 'Healthy verdict requires count and latency data')
      break
    case 'ReleaseRecordV1': {
      unique(record.specDigests, 'release spec digest')
      unique(record.evidenceHashes, 'release evidence hash')
      unique(record.operationIntents.map(intent => intent.operationId), 'operation key')
      unique(record.operationIntents.map(intent => intent.id), 'operation intent ID')
      unique(record.operationReceipts.map(receipt => receipt.id), 'operation receipt ID')
      unique(record.operationReceipts.map(receipt => `${receipt.operationId}:${receipt.providerRevision}`), 'operation provider revision')
      for (const intent of record.operationIntents) {
        require(intent.releaseId === record.id && intent.environment === record.environment && intent.policyDigest === record.policyDigest && intent.fencingToken <= record.fencingToken, 'Mismatched release operation intent')
        require(intent.commit === record.commit && intent.artifactDigest === record.artifact.digest || intent.operation === 'deployRollback', 'Mismatched candidate deployment')
        if (intent.operation === 'deployRollback') require(intent.artifactDigest === record.priorArtifact.digest, 'Rollback artifact mismatch')
      }
      for (const receipt of record.operationReceipts) {
        assertContractSemantics('DeploymentStatusV1', receipt)
        const intent = record.operationIntents.find(value => value.operationId === receipt.operationId)
        require(!!intent, 'Operation receipt has no intent')
        require(receipt.requestDigest === digestJson(intent), 'Operation request digest mismatch')
        for (const key of ['releaseId', 'environment', 'fencingToken', 'commit', 'artifactDigest'] as const) require(intent[key] === receipt[key], 'Mismatched operation receipt')
      }
      if (record.canaryStartedAt && record.canaryDeadline) ordered(record.canaryStartedAt, record.canaryDeadline, 'canary deadline')
      if (record.canaryDeadline && record.promotionDeadline) ordered(record.canaryDeadline, record.promotionDeadline, 'promotion deadline', true)
      if (record.state === 'observing' || record.state === 'accepted') require(!!record.canaryStartedAt && !!record.canaryDeadline && !!record.promotionDeadline, 'Observed release requires deadlines')
      if (record.state === 'accepted') require(record.telemetryIds.length > 0, 'Accepted release requires telemetry references')
      if (record.state === 'quarantined') require(!!record.healthEscalationId, 'Quarantined release requires health inbox reference')
      break
    }
    case 'PricingSnapshotV1':
      ordered(record.observedAt, record.expiresAt, 'pricing expiry')
      break
    case 'ReservationV1':
      ordered(record.createdAt, record.reconcileBy, 'reservation reconciliation')
      require(record.accountingDay.startsWith(`${record.accountingMonth}-`) && record.createdAt.startsWith(`${record.accountingDay}T`), 'Reservation accounting window mismatch')
      if (record.purpose !== 'routine') require(record.purposeEvidence.length > 0, 'Emergency reservation requires authority evidence')
      break
    case 'UsageEventV1':
      { const { eventDigest, ...payload } = record; require(eventDigest === digestJson(payload), 'Usage event digest mismatch') }
      require(record.correctionOf !== record.id, 'Usage correction cannot reference itself')
      if (record.countingSemantics === 'cache-in-input-reasoning-in-output') require(record.cacheTokens <= record.inputTokens && record.reasoningTokens <= record.outputTokens, 'Usage subcounts exceed provider totals')
      break
    case 'ProviderQuotaV1':
      require(record.observedRemaining <= record.total, 'Remaining quota exceeds total')
      ordered(record.windowStart, record.windowEnd, 'quota window')
      ordered(record.windowStart, record.observedAt, 'quota observation start', true)
      ordered(record.observedAt, record.windowEnd, 'quota observation end')
      ordered(record.observedAt, record.expiresAt, 'quota expiry')
      ordered(record.expiresAt, record.windowEnd, 'quota expiry window', true)
      ordered(record.windowEnd, record.resetAt, 'quota reset', true)
      break
    case 'ModelRoleAssignmentV1':
      ordered(record.health.observedAt, record.assignedAt, 'model health observation', true)
      ordered(record.assignedAt, record.health.expiresAt, 'model health expiry')
      unique([record, ...record.fallbackChain].map(model => `${model.provider}/${model.deploymentId}/${model.modelVersion}`), 'fallback model')
      break
  }
}
