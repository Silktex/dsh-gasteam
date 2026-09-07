/** Offline closure against concrete registered snapshots; never a live release authorization. */
import z from 'zod'
import { createPublicKey } from 'node:crypto'
import { artifactRefSchema, commitSchema, digestSchema, httpsUrlSchema, idSchema, recordFields, repositorySchema, revisionSchema, secretRefSchema, textSchema, timestampSchema, uniqueIds } from './common.ts'
import { executableSpecSchema, verifyExecutableSpec } from './spec.ts'
import { criticOutcomeSchema, mutantManifestSchema, verificationEvidenceSchema } from './verification.ts'
import { deploymentCallbackSchema, deploymentRequestSchema, deploymentStatusSchema, releaseRecordSchema, telemetryVerdictSchema } from './release.ts'
import { validateContract } from './index.ts'
import { graphArtifactDescriptorSchema, validateGraphArtifacts } from './graph-core.ts'
import { enabledDarkFactoryConfigSchema } from '../config.ts'
import { canonicalJson, digestJson, parseStrictJson } from '../json.ts'
import { validateWorkflowTemplate, workflowTemplateSchema } from '../../workflows.ts'
import { factoryEscalationSchema } from '../../health.ts'
import { operationalEventSchema } from './operations.ts'

const MAX_BYTES = 12_582_912, MAX_NODES = 256
const digests = z.array(digestSchema).max(64).refine(values => new Set(values).size === values.length)
const registration = { ...recordFields, revision: revisionSchema, digest: digestSchema }
const stages = z.enum(['architecture', 'tests', 'twins', 'mutations', 'critics'])
export const verificationReferenceGraphRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('VerificationEvidenceV1'), value: verificationEvidenceSchema }),
  z.strictObject({ kind: z.literal('CriticOutcomeV1'), value: criticOutcomeSchema }),
  z.strictObject({ kind: z.literal('MutantManifestV1'), value: mutantManifestSchema }),
  z.strictObject({ kind: z.literal('ReleaseRecordV1'), value: releaseRecordSchema }),
  z.strictObject({ kind: z.literal('DeploymentRequestV1'), value: deploymentRequestSchema }),
  z.strictObject({ kind: z.literal('DeploymentStatusV1'), value: deploymentStatusSchema }),
  z.strictObject({ kind: z.literal('DeploymentCallbackV1'), value: deploymentCallbackSchema }),
  z.strictObject({ kind: z.literal('TelemetryVerdictV1'), value: telemetryVerdictSchema }),
])
/** These are externally registered leaves with actual pinned payloads, not trust assertions by ID. */
export const verificationReferenceGraphDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...registration, kind: z.literal('spec'), spec: executableSpecSchema }),
  z.strictObject({ ...registration, kind: z.literal('workflow'), definition: workflowTemplateSchema, taskIds: uniqueIds().min(1) }),
  z.strictObject({ ...registration, kind: z.literal('task'), workflowId: idSchema, stepId: idSchema, specDigest: digestSchema, subject: textSchema }),
  z.strictObject({ ...registration, kind: z.literal('attempt'), taskId: idSchema, generation: revisionSchema, role: z.enum(['worker', 'critic']),
    specDigest: digestSchema, sourceCommit: commitSchema, targetCommit: commitSchema, candidateCommit: commitSchema, candidateTreeDigest: digestSchema,
    context: artifactRefSchema.optional(), modelAssignmentId: idSchema.optional() }),
  z.strictObject({ ...registration, kind: z.literal('model-assignment'), attemptId: idSchema, generation: revisionSchema,
    provider: idSchema, modelVersion: idSchema, catalogRevision: revisionSchema, catalog: artifactRefSchema }),
  z.strictObject({ ...registration, kind: z.literal('verification-stage'), stage: stages, toolchainDigest: digestSchema,
    definition: artifactRefSchema, exitConditions: uniqueIds(32).min(1),
    notApplicable: z.strictObject({ reason: z.enum(['NO_EXTERNAL_DEPENDENCY', 'NON_EXECUTABLE_CHANGE']), specDigests: digests.min(1) }).optional() }),
  z.strictObject({ ...registration, kind: z.literal('integration'), repository: repositorySchema, workflowId: idSchema, taskIds: uniqueIds(64).min(1), attemptIds: uniqueIds(64).min(1),
    specDigests: digests.min(1), evidenceHashes: digests.min(1), sourceCommits: z.array(commitSchema).min(1).max(64), targetCommit: commitSchema,
    candidateCommit: commitSchema, candidateTreeDigest: digestSchema, commit: commitSchema, artifact: artifactRefSchema,
    buildRecipe: artifactRefSchema, completedAt: timestampSchema }),
  z.strictObject({ ...registration, kind: z.literal('policy'), policy: enabledDarkFactoryConfigSchema, snapshot: artifactRefSchema }),
  z.strictObject({ ...registration, kind: z.literal('key'), environment: idSchema,
    purposes: z.array(z.enum(['verification', 'telemetry', 'deployment-request', 'deployment-callback'])).min(1).max(4),
    algorithm: z.enum(['ed25519', 'hmac-sha256']), publicKey: z.string().min(1).max(4096).optional(), secretRef: secretRefSchema.optional(),
    validFrom: timestampSchema, validUntil: timestampSchema, revokedAt: timestampSchema.optional() }),
  z.strictObject({ ...registration, kind: z.literal('deployment-adapter'), environment: idSchema, endpoint: httpsUrlSchema, adapterVersion: idSchema,
    requestKeyId: idSchema, callbackKeyId: idSchema, capabilities: z.strictObject({ idempotency: z.literal(true), statusLookup: z.literal(true), reverseDeployment: z.literal(true) }), qualification: artifactRefSchema }),
  z.strictObject({ ...registration, kind: z.literal('telemetry-query'), environment: idSchema, endpoint: httpsUrlSchema,
    queryRevision: revisionSchema, signerKeyId: idSchema, queries: z.array(z.strictObject({ id: idSchema, query: textSchema })).min(1).max(32), definition: artifactRefSchema }),
  z.strictObject({ ...registration, kind: z.literal('imported-baseline'), environment: idSchema, componentId: idSchema, repository: repositorySchema,
    commit: commitSchema, artifact: artifactRefSchema, deploymentId: idSchema, acceptedAt: timestampSchema,
    authorization: artifactRefSchema, providerStatus: artifactRefSchema, qualifyingHealth: artifactRefSchema }),
])
export const verificationReferenceGraphInputSchema = z.strictObject({
  schemaVersion: z.literal(1), lane: z.literal('verification-release'), projectId: idSchema, policyRevision: revisionSchema,
  records: z.array(verificationReferenceGraphRecordSchema).min(1).max(128),
  definitions: z.array(verificationReferenceGraphDefinitionSchema).min(1).max(128),
  artifacts: z.array(graphArtifactDescriptorSchema).min(1).max(128),
})
export const verificationReferenceGraphSchema = verificationReferenceGraphInputSchema
/** Concrete bridge after quarantine-lane validation; every payload is rechecked against this graph. */
export const verificationHealthContextSchema = z.strictObject({ schemaVersion: z.literal(1),
  releases: z.array(releaseRecordSchema).min(1).max(64), incidents: z.array(factoryEscalationSchema).min(1).max(64),
  events: z.array(operationalEventSchema).min(1).max(64),
})
export type VerificationHealthContext = z.input<typeof verificationHealthContextSchema>
export type VerificationReferenceGraphInput = z.input<typeof verificationReferenceGraphInputSchema>
export type VerificationReferenceGraphRecord = z.output<typeof verificationReferenceGraphRecordSchema>
export type VerificationReferenceGraphDefinition = z.output<typeof verificationReferenceGraphDefinitionSchema>
type Values = { [R in VerificationReferenceGraphRecord as R['kind']]: R['value'] }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Verification reference graph rejected: ${reason}`) }
const time = (value: string) => Date.parse(value)
const sameSet = (a: readonly string[], b: readonly string[]) => same([...a].sort(), [...new Set(b)].sort())

/** Registered leaves terminate this graph. Their origin, live validity and execution truth are not proved. */
export function validateVerificationReferenceGraph(raw: unknown, rawHealthContext?: VerificationHealthContext) {
  let input: z.output<typeof verificationReferenceGraphInputSchema>
  try {
    const value = parseStrictJson(typeof raw === 'string' || raw instanceof Uint8Array ? raw : canonicalJson(raw, MAX_BYTES), MAX_BYTES)
    if (value && typeof value === 'object') {
      const arrays = ['records', 'definitions', 'artifacts'].map(key => Reflect.get(value, key))
      assert(arrays.every(Array.isArray) && arrays.reduce((sum, array) => sum + array.length, 0) <= MAX_NODES, 'total node bound')
    }
    input = verificationReferenceGraphInputSchema.parse(value)
  } catch { throw new Error('Verification reference graph rejected: invalid bounded input or unsupported record lane') }
  const healthContext = rawHealthContext === undefined ? undefined : verificationHealthContextSchema.parse(parseStrictJson(canonicalJson(rawHealthContext, MAX_BYTES), MAX_BYTES))
  assert(input.records.length + input.definitions.length + input.artifacts.length + (healthContext ? healthContext.releases.length + healthContext.incidents.length + healthContext.events.length : 0) <= MAX_NODES, 'combined health context node bound')
  const custody = validateGraphArtifacts(input.projectId, input.artifacts)
  const artifactByDigest = (digest: string) => {
    const found = input.artifacts.find(item => item.reference.digest === digest)
    assert(found, 'unresolved content digest'); return found.reference
  }
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if ('projectId' in value) assert(value.projectId === input.projectId, 'cross-project reference')
    if ('policyRevision' in value) assert(value.policyRevision === input.policyRevision, 'policy revision mismatch')
    if ('mediaType' in value && 'sizeBytes' in value) custody.assertArtifact(artifactRefSchema.parse(value))
    for (const child of Object.values(value)) walk(child)
  }
  const records = new Map<string, VerificationReferenceGraphRecord>()
  const definitions = new Map<string, VerificationReferenceGraphDefinition>()
  for (const entry of input.records) {
    const key = `${entry.kind}:${entry.value.id}`
    assert(!records.has(key), 'duplicate record identity'); walk(entry.value)
    validateContract(entry.kind, entry.value); records.set(key, entry)
  }
  for (const entry of input.definitions) {
    const key = `${entry.kind}:${entry.id}`
    assert(!definitions.has(key), 'duplicate registered identity'); walk(entry)
    const { digest, ...payload } = entry
    assert(digest === digestJson(payload), 'registered payload digest mismatch'); definitions.set(key, entry)
  }
  const healthReleases = new Set<string>()
  if (healthContext) {
    assert(new Set(healthContext.releases.map(value => value.id)).size === healthContext.releases.length && new Set(healthContext.incidents.map(value => value.id)).size === healthContext.incidents.length && new Set(healthContext.events.map(value => value.id)).size === healthContext.events.length, 'ambiguous resolved health context')
    const referents = new Set([...input.records.map(value => value.value.id), ...input.definitions.map(value => value.id), ...input.artifacts.map(value => value.reference.id),
      ...input.records.filter(value => value.kind === 'ReleaseRecordV1').flatMap(value => value.value.operationIntents.map(operation => operation.operationId))])
    const incidents = new Set<string>(), events = new Set<string>()
    for (const release of healthContext.releases) {
      const registered = records.get(`ReleaseRecordV1:${release.id}`)
      assert(registered && same(registered.value, release) && release.healthEscalationId, 'resolved health release payload differs from verification')
      const incident = healthContext.incidents.find(value => value.id === release.healthEscalationId)
      assert(incident && incident.projectId === release.projectId && incident.policyRevision === release.policyRevision && ['release', 'operations'].includes(incident.stage), 'missing or substituted release health incident')
      const effects = [release.id, ...release.operationIntents.map(value => value.operationId)]
      assert(effects.includes(incident.effectId) && incident.evidenceRefs.some(id => effects.includes(id)) && [...incident.evidenceRefs, ...(incident.resolution?.evidenceRefs ?? [])].every(id => referents.has(id)), 'release health effect/evidence mismatch')
      assert(incident.cooldownUntil >= incident.raisedAt && (!incident.acknowledgement || incident.acknowledgement.at >= incident.raisedAt) && (!incident.resolution || incident.resolution.at >= incident.raisedAt), 'release health chronology mismatch')
      const boundEvents = healthContext.events.filter(event => event.recordId === release.id && event.healthEscalationId === incident.id)
      assert(boundEvents.length > 0, 'release health event missing')
      for (const event of boundEvents) {
        walk(event); validateContract('OperationalEventV1', event)
        assert(event.projectId === release.projectId && event.policyRevision === release.policyRevision && event.reasonCode === incident.reason && event.expectedRecordRevision + 1 === release.revision && time(event.occurredAt) >= incident.raisedAt && (!event.releaseId || event.releaseId === release.id) && (!event.workflowId || event.workflowId === release.workflowId) && (!event.attemptId || release.attemptIds.includes(event.attemptId)), 'release health event reason/revision/identity mismatch')
        events.add(event.id)
      }
      incidents.add(incident.id); healthReleases.add(release.id)
    }
    assert(incidents.size === healthContext.incidents.length && events.size === healthContext.events.length, 'orphan resolved release health context')
  }
  function record<K extends VerificationReferenceGraphRecord['kind']>(kind: K, id: string): Values[K] {
    const found = records.get(`${kind}:${id}`); assert(found, `unresolved ${kind}`); return found.value as Values[K]
  }
  function definition<K extends VerificationReferenceGraphDefinition['kind']>(kind: K, id: string): Extract<VerificationReferenceGraphDefinition, { kind: K }> {
    const found = definitions.get(`${kind}:${id}`); assert(found, `unresolved ${kind}`); return found as Extract<VerificationReferenceGraphDefinition, { kind: K }>
  }
  const select = <K extends VerificationReferenceGraphRecord['kind']>(kind: K): Values[K][] => input.records.filter(entry => entry.kind === kind).map(entry => entry.value as Values[K])
  const specs = new Map<string, Extract<VerificationReferenceGraphDefinition, { kind: 'spec' }>>()
  const policies = new Map<string, Extract<VerificationReferenceGraphDefinition, { kind: 'policy' }>>()
  const evidence = new Map<string, Values['VerificationEvidenceV1']>()
  for (const entry of input.definitions) {
    if (entry.kind === 'spec') { verifyExecutableSpec(entry.spec); assert(entry.id === entry.spec.id && !specs.has(entry.spec.specDigest), 'spec identity/digest alias'); specs.set(entry.spec.specDigest, entry) }
    if (entry.kind === 'policy') {
      assert(!policies.has(entry.snapshot.digest) && same(parseStrictJson(custody.readArtifact(entry.snapshot)), entry.policy) && digestJson(entry.policy) === entry.snapshot.digest, 'policy snapshot mismatch or alias')
      assert(entry.policy.projectIds.includes(input.projectId), 'policy project mismatch'); policies.set(entry.snapshot.digest, entry)
    }
  }
  const specFor = (digest: string) => { const found = specs.get(digest); assert(found, 'unresolved spec digest'); return found.spec }
  const policyFor = (digest: string) => { const found = policies.get(digest); assert(found, 'unresolved policy digest'); return found }
  const signedBy = (keyId: string, purpose: 'verification' | 'telemetry' | 'deployment-request' | 'deployment-callback', environment: string, at: string) => {
    const key = definition('key', keyId)
    assert(key.environment === environment && key.purposes.includes(purpose), 'signer key purpose/environment mismatch')
    assert(time(key.validFrom) <= time(at) && time(at) < time(key.validUntil) && (!key.revokedAt || time(at) < time(key.revokedAt)), 'signer key expired or revoked at signing')
    return key
  }
  const adapters = new Map<string, Extract<VerificationReferenceGraphDefinition, { kind: 'deployment-adapter' }>>()
  const keyMaterial = new Map<string, Set<string>>()
  for (const item of input.definitions) {
    if (item.kind === 'deployment-adapter') { assert(!adapters.has(item.environment), 'adapter environment alias'); adapters.set(item.environment, item) }
    if (item.kind === 'key') {
      assert(new Set(item.purposes).size === item.purposes.length && time(item.validFrom) < time(item.validUntil), 'invalid key registration')
      assert(!(item.purposes.includes('verification') && item.purposes.includes('telemetry')), 'telemetry key must be separate from verification key')
      const asymmetric = item.purposes.some(value => value === 'verification' || value === 'telemetry')
      if (asymmetric) {
        assert(item.algorithm === 'ed25519' && item.publicKey && !item.secretRef, 'invalid public signing key registration')
        const publicKey = createPublicKey(item.publicKey)
        assert(publicKey.asymmetricKeyType === 'ed25519', 'signing key is not Ed25519')
        const material = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
        const purposes = keyMaterial.get(material) ?? new Set<string>()
        for (const purpose of item.purposes) purposes.add(purpose)
        assert(!(purposes.has('verification') && purposes.has('telemetry')), 'telemetry and verification keys reuse public key material')
        keyMaterial.set(material, purposes)
      } else assert(item.algorithm === 'hmac-sha256' && item.secretRef && !item.publicKey, 'invalid deployment key registration')
    }
  }
  for (const item of input.definitions) switch (item.kind) {
    case 'spec': {
      const spec = item.spec, policy = policyFor(spec.policyDigest).policy
      artifactByDigest(spec.rulesDigest); artifactByDigest(spec.toolchainDigest)
      assert(input.definitions.some(value => value.kind === 'workflow' && digestJson(value.definition) === spec.workflowDigest), 'unresolved spec workflow digest')
      assert(spec.invariants.every(value => policy.verification.checkIds.includes(value.checkId)) && spec.acceptanceScenarios.every(value => policy.verification.fixtureIds.includes(value.fixtureId) && policy.verification.commands.some(command => command.id === value.commandId)), 'spec check/fixture/command outside registered policy')
      break
    }
    case 'workflow':
      assert(same(validateWorkflowTemplate(item.definition), item.definition), 'workflow must be normalized')
      for (const id of item.taskIds) assert(definition('task', id).workflowId === item.id, 'workflow task mismatch')
      break
    case 'task': {
      const workflow = definition('workflow', item.workflowId)
      assert(workflow.taskIds.includes(item.id) && workflow.definition.steps.some(step => step.id === item.stepId) && digestJson(workflow.definition) === specFor(item.specDigest).workflowDigest, 'task workflow/spec mismatch'); break
    }
    case 'attempt': {
      assert(definition('task', item.taskId).specDigest === item.specDigest, 'attempt task/spec mismatch')
      artifactByDigest(item.candidateTreeDigest)
      if (item.role === 'critic') assert(item.context && item.modelAssignmentId, 'critic attempt lacks context/model registration')
      if (item.modelAssignmentId) assert(definition('model-assignment', item.modelAssignmentId).attemptId === item.id, 'attempt model ownership mismatch')
      break
    }
    case 'model-assignment': {
      const attempt = definition('attempt', item.attemptId)
      const catalog = z.strictObject({ revision: revisionSchema, models: z.array(z.strictObject({ provider: idSchema, modelVersion: idSchema })).min(1).max(128) }).parse(parseStrictJson(custody.readArtifact(item.catalog)))
      assert(attempt.generation === item.generation && attempt.modelAssignmentId === item.id && catalog.revision === item.catalogRevision && catalog.models.filter(model => model.provider === item.provider && model.modelVersion === item.modelVersion).length === 1, 'model assignment catalog/attempt mismatch'); break
    }
    case 'verification-stage': {
      artifactByDigest(item.toolchainDigest)
      const stage = z.strictObject({ stage: stages, revision: revisionSchema, toolchainDigest: digestSchema, exitConditions: uniqueIds(32), checkIds: uniqueIds(128), commandIds: uniqueIds(128), fixtureIds: uniqueIds(128) }).parse(parseStrictJson(custody.readArtifact(item.definition)))
      assert(stage.stage === item.stage && stage.revision === item.revision && stage.toolchainDigest === item.toolchainDigest && same(stage.exitConditions, item.exitConditions), 'stage definition artifact differs from registration')
      for (const policy of policies.values()) assert(stage.checkIds.every(id => policy.policy.verification.checkIds.includes(id)) && stage.commandIds.every(id => policy.policy.verification.commands.some(command => command.id === id)) && stage.fixtureIds.every(id => policy.policy.verification.fixtureIds.includes(id)), 'stage definitions escape pinned policy registries')
      break
    }
    case 'deployment-adapter': {
      assert(definition('key', item.requestKeyId).purposes.includes('deployment-request') && definition('key', item.callbackKeyId).purposes.includes('deployment-callback'), 'adapter key purpose mismatch')
      const qualification = z.strictObject({ adapterVersion: idSchema, endpoint: httpsUrlSchema, capabilities: z.strictObject({ idempotency: z.literal(true), statusLookup: z.literal(true), reverseDeployment: z.literal(true) }), verifiedAt: timestampSchema }).parse(parseStrictJson(custody.readArtifact(item.qualification)))
      assert(qualification.adapterVersion === item.adapterVersion && qualification.endpoint === item.endpoint && same(qualification.capabilities, item.capabilities), 'adapter qualification binding mismatch'); break
    }
    case 'telemetry-query':
      assert(definition('key', item.signerKeyId).purposes.includes('telemetry') && same(parseStrictJson(custody.readArtifact(item.definition)), { queryRevision: item.queryRevision, queries: item.queries }), 'telemetry query definition mismatch'); break
    case 'imported-baseline': {
      const authorization = z.strictObject({ projectId: idSchema, environment: idSchema, componentId: idSchema, repository: repositorySchema, releaseId: idSchema, commit: commitSchema, artifactDigest: digestSchema, deploymentId: idSchema, actor: idSchema, authorizedAt: timestampSchema }).parse(parseStrictJson(custody.readArtifact(item.authorization)))
      assert(authorization.projectId === item.projectId && authorization.environment === item.environment && authorization.componentId === item.componentId && same(authorization.repository, item.repository) && authorization.releaseId === item.id && authorization.commit === item.commit && authorization.artifactDigest === item.artifact.digest && authorization.deploymentId === item.deploymentId && time(authorization.authorizedAt) <= time(item.acceptedAt), 'imported baseline authorization binding mismatch')
      const status = z.strictObject({ deploymentId: idSchema, commit: commitSchema, artifactDigest: digestSchema, status: z.literal('succeeded'), observedAt: timestampSchema }).parse(parseStrictJson(custody.readArtifact(item.providerStatus)))
      const health = z.strictObject({ deploymentId: idSchema, artifactDigest: digestSchema, result: z.literal('HEALTHY'), observedAt: timestampSchema }).parse(parseStrictJson(custody.readArtifact(item.qualifyingHealth)))
      assert(status.deploymentId === item.deploymentId && health.deploymentId === item.deploymentId && status.commit === item.commit && status.artifactDigest === item.artifact.digest && health.artifactDigest === item.artifact.digest && time(status.observedAt) <= time(item.acceptedAt) && time(health.observedAt) <= time(item.acceptedAt), 'imported baseline provenance mismatch'); break
    }
    case 'integration': case 'policy': break
  }
  for (const critic of select('CriticOutcomeV1')) {
    const spec = specFor(critic.specDigest), attempt = definition('attempt', critic.attemptId), model = definition('model-assignment', critic.modelAssignmentId)
    assert(attempt.role === 'critic' && attempt.specDigest === critic.specDigest && attempt.candidateCommit === critic.candidateCommit && attempt.context?.digest === critic.contextDigest && attempt.modelAssignmentId === model.id && model.attemptId === attempt.id && model.provider === critic.provider && model.modelVersion === critic.modelVersion, 'critic attempt/context/model binding mismatch')
    assert(critic.coveredCriteria.every(id => spec.acceptanceScenarios.some(scenario => scenario.id === id) || spec.invariants.some(invariant => invariant.id === id)), 'critic covers unknown criterion')
    if (critic.verdict === 'ACCEPT') assert([...spec.acceptanceScenarios, ...spec.invariants].every(criterion => critic.coveredCriteria.includes(criterion.id)), 'accepting critic has incomplete criterion coverage')
  }
  for (const item of select('VerificationEvidenceV1')) {
    assert(!evidence.has(item.evidenceHash), 'evidence digest alias'); evidence.set(item.evidenceHash, item)
    assert(item.batchMembers.length === 0, 'merge batching unsupported in v1')
    const spec = specFor(item.specDigest), task = definition('task', item.taskId), attempt = definition('attempt', item.attemptId), policy = policyFor(item.policyDigest).policy
    assert(attempt.role === 'worker' && attempt.taskId === task.id && attempt.generation === item.generation && task.workflowId === item.workflowId && task.specDigest === spec.specDigest && attempt.specDigest === spec.specDigest && spec.policyDigest === item.policyDigest && spec.toolchainDigest === item.toolchainDigest, 'evidence task/attempt/spec/policy binding mismatch')
    for (const key of ['sourceCommit', 'targetCommit', 'candidateCommit', 'candidateTreeDigest'] as const) assert(item[key] === attempt[key], 'evidence candidate/source binding mismatch')
    const key = signedBy(item.signerKeyId, 'verification', item.environment, item.createdAt)
    assert(policy.verification.trustedPublicKeys.some(value => value.keyId === key.id && value.publicKey === key.publicKey), 'evidence signer absent from pinned policy')
    for (const stage of item.stages) {
      const registered = definition('verification-stage', stage.id)
      assert(registered.revision === stage.definitionRevision && registered.stage === stage.stage && registered.toolchainDigest === item.toolchainDigest && registered.exitConditions.includes(stage.exitCondition), 'verification stage revision/toolchain mismatch')
      if (stage.result === 'NOT_APPLICABLE') assert(registered.notApplicable?.specDigests.includes(spec.specDigest) && registered.notApplicable.reason === (stage.stage === 'twins' ? 'NO_EXTERNAL_DEPENDENCY' : 'NON_EXECUTABLE_CHANGE'), 'missing pinned applicability registration')
    }
    for (const critic of item.critics) {
      assert(same(record('CriticOutcomeV1', critic.id), critic), 'embedded critic differs from registered record')
      const criticAttempt = definition('attempt', critic.attemptId)
      assert(criticAttempt.id !== attempt.id && criticAttempt.candidateTreeDigest === item.candidateTreeDigest && criticAttempt.sourceCommit === item.sourceCommit && criticAttempt.targetCommit === item.targetCommit, 'critic independence/candidate mismatch')
    }
    assert(new Set(item.critics.map(critic => critic.contextDigest)).size === item.critics.length, 'critics reuse a context')
    if (item.diversityDeficit) assert(input.definitions.some(value => value.kind === 'model-assignment' && value.catalogRevision === item.diversityDeficit!.catalogRevision && value.catalog.digest === item.diversityDeficit!.catalogDigest), 'unresolved diversity catalog')
    const mutation = item.stages.find(stage => stage.stage === 'mutations')
    if (mutation && mutation.result !== 'NOT_APPLICABLE') {
      const manifests = select('MutantManifestV1').filter(manifest => manifest.attemptId === item.attemptId && manifest.generation === item.generation && manifest.candidateCommit === item.candidateCommit && mutation.artifacts.some(ref => ref.digest === digestJson(manifest)))
      assert(manifests.length === 1, 'mutation stage lacks exact manifest artifact')
      if (mutation.result === 'PASSED') {
        const manifest = manifests[0]!, valid = manifest.mutants.filter(mutant => ['KILLED', 'SURVIVED', 'NO_COVERAGE'].includes(mutant.outcome)), killed = valid.filter(mutant => mutant.outcome === 'KILLED' && mutant.repeatedKill).length
        assert(manifest.baseline === 'PASSED_TWICE' && valid.length > 0 && manifest.mutants.every(mutant => !['TIMEOUT', 'INFRA_ERROR'].includes(mutant.outcome)) && killed / valid.length >= policy.verification.mutation.threshold && valid.filter(mutant => mutant.outcome !== 'KILLED').length <= policy.verification.mutation.maxSurvivors, 'passing mutation stage contradicts manifest/policy')
      }
    }
  }
  for (const manifest of select('MutantManifestV1')) {
    const attempt = definition('attempt', manifest.attemptId)
    assert(attempt.generation === manifest.generation && attempt.candidateCommit === manifest.candidateCommit && select('VerificationEvidenceV1').some(item => item.attemptId === attempt.id && item.stages.some(stage => stage.stage === 'mutations' && stage.artifacts.some(ref => ref.digest === digestJson(manifest)))), 'dangling mutant manifest')
  }
  for (const integration of input.definitions.filter(item => item.kind === 'integration')) {
    const workflow = definition('workflow', integration.workflowId)
    const bound = integration.evidenceHashes.map(hash => { const found = evidence.get(hash); assert(found, 'unresolved integration evidence'); return found })
    assert(sameSet(integration.taskIds, bound.map(item => item.taskId)) && sameSet(integration.attemptIds, bound.map(item => item.attemptId)) && sameSet(integration.specDigests, bound.map(item => item.specDigest)) && sameSet(integration.sourceCommits, bound.map(item => item.sourceCommit)), 'integration contributing identities differ')
    for (const item of bound) assert(item.workflowId === workflow.id && item.decision === 'ACCEPT' && item.executionMode === 'deploying' && item.targetCommit === integration.targetCommit && item.candidateCommit === integration.candidateCommit && item.candidateTreeDigest === integration.candidateTreeDigest && time(item.createdAt) <= time(integration.completedAt) && time(integration.completedAt) < time(item.expiresAt), 'integration evidence is stale/rejected or candidate differs')
    assert(integration.commit === integration.candidateCommit, 'integration does not preserve verified candidate')
    const build = z.strictObject({ candidateCommit: commitSchema, candidateTreeDigest: digestSchema, artifactDigest: digestSchema, toolchainDigest: digestSchema, commandId: idSchema, commandDigest: digestSchema }).parse(parseStrictJson(custody.readArtifact(integration.buildRecipe)))
    assert(build.candidateCommit === integration.candidateCommit && build.candidateTreeDigest === integration.candidateTreeDigest && build.artifactDigest === integration.artifact.digest && bound.every(item => {
      const delivery = policyFor(item.policyDigest).policy.delivery
      return item.toolchainDigest === build.toolchainDigest && delivery.enabled && delivery.artifactBuilder.id === build.commandId && digestJson(delivery.artifactBuilder) === build.commandDigest
    }), 'build recipe provenance mismatch')
  }
  const releaseKeys = new Set<string>(), operationKeys = new Set<string>()
  for (const release of select('ReleaseRecordV1')) {
    assert(!release.healthEscalationId || healthReleases.has(release.id), 'quarantine health references require validated concrete release context')
    if (release.diagnosticTaskId) definition('task', release.diagnosticTaskId)
    const recovery = release.rollbackIntegrationId ? definition('integration', release.rollbackIntegrationId) : undefined
    const identity = canonicalJson([release.environment, release.integrationReceiptId]); assert(!releaseKeys.has(identity), 'duplicate release integration/environment'); releaseKeys.add(identity)
    const ancestors = new Set([release.id])
    let priorId = release.priorAcceptedReleaseId
    while (records.has(`ReleaseRecordV1:${priorId}`)) {
      assert(!ancestors.has(priorId), 'release baseline reference cycle'); ancestors.add(priorId)
      priorId = record('ReleaseRecordV1', priorId).priorAcceptedReleaseId
    }
    definition('imported-baseline', priorId)
    const integration = definition('integration', release.integrationReceiptId), policy = policyFor(release.policyDigest)
    assert(release.workflowId === integration.workflowId && same(release.repository, integration.repository) && release.commit === integration.commit && same(release.artifact, integration.artifact) && sameSet(release.attemptIds, integration.attemptIds) && sameSet(release.specDigests, integration.specDigests) && sameSet(release.evidenceHashes, integration.evidenceHashes) && same(release.policySnapshot, policy.snapshot), 'release integration/spec/artifact binding mismatch')
    assert(policy.policy.mode === 'staging' || policy.policy.mode === 'production', 'release requires a deploying policy snapshot')
    assert(policy.policy.delivery.enabled && policy.policy.delivery.environments.some(environment => environment.id === release.environment && environment.projectId === release.projectId && environment.componentIds.includes(release.componentId)), 'release environment outside pinned policy')
    for (const hash of release.evidenceHashes) assert(evidence.get(hash)?.environment === release.environment && evidence.get(hash)?.policyDigest === release.policyDigest, 'release evidence environment/policy mismatch')
    const priorRelease = records.get(`ReleaseRecordV1:${release.priorAcceptedReleaseId}`)
    const baseline = priorRelease ? record('ReleaseRecordV1', release.priorAcceptedReleaseId) : definition('imported-baseline', release.priorAcceptedReleaseId)
    assert(baseline.id !== release.id && baseline.environment === release.environment && baseline.componentId === release.componentId && same(baseline.repository, release.repository) && same(baseline.artifact, release.priorArtifact) && (!('state' in baseline) || baseline.state === 'accepted'), 'prior accepted release/artifact mismatch')
    const priorDeployment = 'deploymentId' in baseline ? baseline.deploymentId : baseline.operationReceipts.findLast(status => status.status === 'succeeded' && baseline.operationIntents.some(intent => intent.operationId === status.operationId && intent.operation === 'promote'))?.deploymentId
    assert(priorDeployment, 'prior release lacks promoted deployment')
    const adapter = adapters.get(release.environment); assert(adapter, 'unresolved deployment adapter')
    assert(policy.policy.delivery.enabled && adapter.endpoint === policy.policy.delivery.adapter.endpoint && adapter.adapterVersion === policy.policy.delivery.adapter.version && adapter.requestKeyId === policy.policy.delivery.adapter.keyId, 'adapter differs from pinned policy')
    let expectedDeployment = priorDeployment, precedingAt = time(integration.completedAt)
    for (const request of release.operationIntents) {
      assert(same(record('DeploymentRequestV1', request.id), request), 'embedded deployment request alias')
      const operationKey = `${release.environment}:${request.operationId}`; assert(!operationKeys.has(operationKey), 'operation identity reused'); operationKeys.add(operationKey)
      signedBy(request.keyId, 'deployment-request', release.environment, request.timestamp)
      assert(request.keyId === adapter.requestKeyId && request.expectedPriorDeployment === expectedDeployment && time(request.timestamp) >= precedingAt, 'deployment request prior/key/time mismatch')
      if (request.operation === 'deployRollback') assert(recovery && recovery.commit === request.commit && same(recovery.artifact, release.priorArtifact) && same(recovery.repository, release.repository), 'rollback lacks verified recovery integration/artifact')
      const statuses = release.operationReceipts.filter(status => status.operationId === request.operationId)
      for (const [index, status] of statuses.entries()) {
        assert(same(record('DeploymentStatusV1', status.id), status) && time(status.observedAt) >= time(request.timestamp), 'embedded deployment status alias/time mismatch')
        const previous = statuses[index - 1]
        if (previous) assert(status.providerRevision > previous.providerRevision && time(status.observedAt) >= time(previous.observedAt) && !['succeeded', 'failed'].includes(previous.status), 'provider revision/terminal status regression')
      }
      const latest = statuses.at(-1)
      if (latest?.status === 'succeeded') expectedDeployment = latest.deploymentId!
      precedingAt = Math.max(time(request.timestamp), latest ? time(latest.observedAt) : 0)
      if (release.operationIntents.at(-1) !== request) assert(latest && ['succeeded', 'failed'].includes(latest.status), 'new operation follows unresolved deployment')
    }
    const succeeded = (operation: string) => release.operationReceipts.some(status => status.status === 'succeeded' && release.operationIntents.some(request => request.operationId === status.operationId && request.operation === operation))
    if (release.state === 'observing' || release.state === 'accepted') assert(succeeded('deployCanary'), 'observed release lacks successful canary deployment')
    if (release.state === 'accepted') assert(succeeded('promote') && release.telemetryIds.every(id => record('TelemetryVerdictV1', id).result === 'HEALTHY'), 'accepted release lacks promotion/healthy telemetry')
    if (release.state === 'rolled_back') assert(recovery && release.diagnosticTaskId && succeeded('deployRollback'), 'rolled-back release lacks recovery integration/diagnostic/deployment')
    for (const id of release.telemetryIds) assert(record('TelemetryVerdictV1', id).releaseId === release.id, 'release telemetry ownership mismatch')
  }
  for (const request of select('DeploymentRequestV1')) assert(record('ReleaseRecordV1', request.releaseId).operationIntents.some(value => same(value, request)), 'dangling deployment request')
  for (const status of select('DeploymentStatusV1')) assert(record('ReleaseRecordV1', status.releaseId).operationReceipts.some(value => same(value, status)), 'dangling deployment status')
  for (const callback of select('DeploymentCallbackV1')) {
    const status = record('DeploymentStatusV1', callback.status.id), release = record('ReleaseRecordV1', status.releaseId)
    assert(same(status, callback.status) && adapters.get(release.environment)?.callbackKeyId === callback.keyId && time(callback.timestamp) - time(status.observedAt) <= 300_000, 'callback status/key/freshness mismatch')
    signedBy(callback.keyId, 'deployment-callback', release.environment, callback.timestamp)
  }
  for (const telemetry of select('TelemetryVerdictV1')) {
    const release = record('ReleaseRecordV1', telemetry.releaseId), policy = policyFor(telemetry.policyDigest).policy
    assert(release.telemetryIds.includes(telemetry.id) && telemetry.artifactDigest === release.artifact.digest && telemetry.policyDigest === release.policyDigest, 'telemetry release/artifact/policy mismatch')
    const deployed = release.operationReceipts.find(status => status.deploymentId === telemetry.deploymentId && status.status === 'succeeded' && status.artifactDigest === telemetry.artifactDigest)
    assert(deployed && time(deployed.observedAt) <= time(telemetry.sample.start) && (!release.canaryStartedAt || time(release.canaryStartedAt) <= time(telemetry.sample.start)), 'telemetry deployment/sample mismatch')
    const queries = input.definitions.filter(item => item.kind === 'telemetry-query').filter(item => item.environment === release.environment && item.queryRevision === telemetry.queryRevision && item.signerKeyId === telemetry.signerKeyId)
    assert(queries.length === 1, 'unresolved/ambiguous telemetry query revision')
    const query = queries[0]!
    assert(policy.delivery.enabled && query.queries.every(item => policy.delivery.enabled && policy.delivery.telemetry.some(registered => registered.id === item.id && registered.query === item.query && registered.endpoint === query.endpoint && registered.keyId === query.signerKeyId)), 'telemetry query differs from pinned policy')
    signedBy(telemetry.signerKeyId, 'telemetry', release.environment, telemetry.collectedAt)
  }
  for (const critic of select('CriticOutcomeV1')) assert(select('VerificationEvidenceV1').some(item => item.critics.some(value => value.id === critic.id)), 'dangling critic')
  return { lane: 'verification-release' as const, records: input.records.length, registeredDefinitions: input.definitions.length, artifacts: input.artifacts.length,
    resolvedHealthReferences: healthReleases.size, authorityVerified: false as const, signaturesVerified: false as const, executionVerified: false as const,
    limitations: ['Registered spec/source authority and registry authenticity are external', 'No cryptographic signature verification', 'No live stage execution, adapter conformance, SLO evaluation or lifecycle history proof', 'Merge batching is unsupported; quarantine health requires concrete composed context'] as const }
}
