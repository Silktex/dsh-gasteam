/** Compiled inside the installed DSH profile; never executed or resolved against
 * development workspace aliases. A missing declaration or any-typed export fails.
 */
import {
  contracts, createFactoryContractCodec, validateContract,
  DarkFactoryIngestionStore, type IngestionStoreOptions, validateReferenceSnapshot,
  DarkFactoryCompilationStore, DarkFactoryCompilationController, type CompilationStoreOptions, type CompilationIntentInput,
  DarkFactoryGithubScanStore, type GithubScanStoreOptions, DarkFactoryGithubScanner, type GithubScannerHost,
  type ProviderApiEnvelopeV1, type GithubScanPageOptions, readGithubScanPage,
  DarkFactoryProviderRequestStore, type ProviderRequestStoreOptions, reconcileGithubDependabotAlert, type GithubDependabotReconciliationOptions,
  validateReferenceGraph, validateVerificationReferenceGraph, validateEconomicsReferenceGraph, validateQuarantineReferenceGraph,
  validateFactoryReferenceGraph, factoryReferenceGraphJsonSchemas,
  type InboundEnvelopeV1, type InboundWorkItemV1, type IngressReceiptV1, type ExecutableSpecV1,
  type CompilerOutcomeV1, type AdmissionReceiptV1, type CriticOutcomeV1, type VerificationEvidenceV1,
  type MutantManifestV1, type DeploymentRequestV1, type DeploymentStatusV1, type DeploymentCallbackV1,
  type TelemetryVerdictV1, type ReleaseRecordV1, type PricingSnapshotV1, type ReservationV1,
  type UsageEventV1, type ProviderQuotaV1, type ModelRoleAssignmentV1, type OperationalEventV1,
  DarkFactoryMonitoringReconciler,
  reconcileSentrySource, type SentryReconciliationOptions, type SentryReconciliationResult,
  type ReconciledSentryItem, type SentryReconciliationProvenance,
  sentryReconciliationLookupSchema, type SentryReconciliationLookup,
  reconcileApmSource, type ApmReconciliationOptions, type ApmReconciliationResult,
  type ReconciledApmItem, type ApmReconciliationProvenance,
  apmReconciliationLookupSchema, type ApmReconciliationLookup,
  readMonitoringResource, type MonitoringReadOptions, type MonitoringResult,
  MonitoringProviderFailure, type MonitoringReason,
  type EnabledDarkFactoryConfig, type ReconciliationHost,
} from 'dsh-team/darkfactory'

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type IsAny<T> = 0 extends (1 & T) ? true : false
type Records = {
  InboundEnvelopeV1: InboundEnvelopeV1; InboundWorkItemV1: InboundWorkItemV1; IngressReceiptV1: IngressReceiptV1
  ExecutableSpecV1: ExecutableSpecV1; CompilerOutcomeV1: CompilerOutcomeV1; AdmissionReceiptV1: AdmissionReceiptV1
  CriticOutcomeV1: CriticOutcomeV1; VerificationEvidenceV1: VerificationEvidenceV1; MutantManifestV1: MutantManifestV1
  DeploymentRequestV1: DeploymentRequestV1; DeploymentStatusV1: DeploymentStatusV1; DeploymentCallbackV1: DeploymentCallbackV1
  TelemetryVerdictV1: TelemetryVerdictV1; ReleaseRecordV1: ReleaseRecordV1; PricingSnapshotV1: PricingSnapshotV1
  ReservationV1: ReservationV1; UsageEventV1: UsageEventV1; ProviderQuotaV1: ProviderQuotaV1
  ModelRoleAssignmentV1: ModelRoleAssignmentV1; OperationalEventV1: OperationalEventV1
}
export type AllTwentyPublicNames = Assert<Equal<keyof Records, keyof typeof contracts>>
export type AllRecordsHaveConcreteTypes = Assert<Equal<{ [K in keyof Records]: IsAny<Records[K]> }[keyof Records], false>>
export type AllRecordsMatchSchemas = Assert<Equal<{ [K in keyof Records]: Equal<Records[K], ReturnType<(typeof contracts)[K]['parse']>> }[keyof Records], true>>
export type AllRecordsCarryIdentity = Assert<Records[keyof Records] extends { schemaVersion: 1; id: string; projectId: string; policyRevision: number } ? true : false>

declare const envelope: InboundEnvelopeV1
const sameEnvelope: InboundEnvelopeV1 = validateContract('InboundEnvelopeV1', envelope)
const schemaVersion: 1 = sameEnvelope.schemaVersion
// @ts-expect-error Public versions must not degrade into permissive any.
const wrongVersion: InboundEnvelopeV1 = { ...envelope, schemaVersion: 2 }
// @ts-expect-error Project identities retain their string type.
const wrongProject: InboundEnvelopeV1 = { ...envelope, projectId: 5 }
const codec = createFactoryContractCodec('InboundEnvelopeV1', 'project')
const strictCodec: 'strict' = codec.mode
// @ts-expect-error Unknown public records must be rejected statically.
createFactoryContractCodec('InventedRecordV1', 'project')
// @ts-expect-error The factory codec is strict, never opaque.
const opaqueCodec: 'opaque' = codec.mode

export function compiledGraphSurface(raw: unknown) {
  const source: false = validateReferenceGraph(raw).authorityVerified
  const verification: false = validateVerificationReferenceGraph(raw).authorityVerified
  const economics: false = validateEconomicsReferenceGraph(raw).authorityVerified
  const quarantine: false = validateQuarantineReferenceGraph(raw).authorityVerified
  const dispatched: false = validateFactoryReferenceGraph(raw).authorityVerified
  const snapshot: false = validateReferenceSnapshot(raw).authorityVerified
  const schemas = factoryReferenceGraphJsonSchemas()
  type FourLanes = Assert<Equal<keyof typeof schemas, 'source-admission' | 'verification-release' | 'fleet-economics' | 'quarantine-health'>>
  const fourLanes: FourLanes = true
  // @ts-expect-error No unknown lane is added by declaration widening.
  schemas['invented-lane']
  return { source, verification, economics, quarantine, dispatched, snapshot, fourLanes, schemaVersion, strictCodec }
}

export async function compiledMigrationSurface(directory: string, options: IngestionStoreOptions) {
  const migrated = await DarkFactoryIngestionStore.migrate(directory, options, {
    migrationId: 'type-fixture', maxBytes: 1_048_576,
    validateReferences: async snapshot => {
      type ConcreteCustody = Assert<Equal<IsAny<typeof snapshot.custody>, false>>
      const checked: ConcreteCustody = true
      const revision: number = snapshot.revision
      void checked; void revision
    },
  })
  const layout: 2 = migrated.storageLayout
  const backup: string = migrated.backup
  // @ts-expect-error Reference validation is required even though no migration runs in this fixture.
  await DarkFactoryIngestionStore.migrate(directory, options, { migrationId: 'incomplete' })
  return { layout, backup }
}

export async function compiledCompilationSurface(directory: string, options: CompilationStoreOptions,
  host: ConstructorParameters<typeof DarkFactoryCompilationController>[0], intent: CompilationIntentInput) {
  const store = await DarkFactoryCompilationStore.open(directory, options)
  const controller = new DarkFactoryCompilationController(host)
  const result = await controller.compile({ projectId: intent.context.ingress.projectId, intent })
  type ConcreteResult = Assert<Equal<IsAny<typeof result>, false>>
  const checked: ConcreteResult = true
  const id: string = result.id
  // @ts-expect-error A compiler intent cannot omit its host authority and registered workflow bindings.
  await controller.compile({ projectId: 'project', intent: { context: intent.context } })
  await controller.settled()
  await store.close()
  return { id, checked }
}

export async function compiledProviderSurface(directory: string, options: ProviderRequestStoreOptions, reader: GithubDependabotReconciliationOptions) {
  const budget = await DarkFactoryProviderRequestStore.open(directory, options)
  const available: number = budget.availability('2026-09-06T12:00:00Z').available
  const result = await reconcileGithubDependabotAlert(reader)
  type ConcreteProviderResult = Assert<Equal<IsAny<typeof result>, false>>
  const checked: ConcreteProviderResult = true
  if (result.decision === 'trusted') {
    const identity: 'host-configured-dependabot-sensor' = result.provenance.identityBinding
    const fix: string | null = result.issue.advisory.availableFix
    void identity; void fix
  }
  // @ts-expect-error Every reservation binds an actual registered project and route before transport.
  await budget.reserve({ at: '2026-09-06T12:00:00Z', expectedRevision: 0 })
  await budget.close()
  return { available, checked }
}

export async function compiledScannerSurface(directory: string, options: GithubScanStoreOptions, reader: GithubScanPageOptions, envelope: ProviderApiEnvelopeV1, host: GithubScannerHost) {
  const store = await DarkFactoryGithubScanStore.open(directory, options)
  const page = await readGithubScanPage(reader)
  type ConcretePage = Assert<Equal<IsAny<typeof page>, false>>
  const checked: ConcretePage = true
  const principal: string = envelope.providerRead.scannerId
  // @ts-expect-error Provider API custody cannot claim a webhook signing key.
  const key: string = envelope.signingKeyId
  if (page.decision === 'trusted') { const number: number | undefined = page.entries[0]?.number; void number }
  void DarkFactoryGithubScanner.open; void host; void key
  await store.close()
  return { checked, principal }
}

export async function compiledMonitoringSurface(
  policy: EnabledDarkFactoryConfig,
  host: ReconciliationHost,
  sentryOptions: SentryReconciliationOptions,
  apmOptions: ApmReconciliationOptions,
  readOptions: MonitoringReadOptions,
  rawLookup: unknown,
) {
  const reconciler = await DarkFactoryMonitoringReconciler.open(policy, host)
  type ConcreteReconciler = Assert<Equal<IsAny<typeof reconciler>, false>>
  const checkedReconciler: ConcreteReconciler = true
  await reconciler.runOnce()

  const sentryResult = await reconcileSentrySource(sentryOptions)
  type ConcreteSentryResult = Assert<Equal<IsAny<typeof sentryResult>, false>>
  const checkedSentry: ConcreteSentryResult = true
  if (sentryResult.decision === 'trusted') {
    const revision: string = sentryResult.sourceRevision
    const binding: 'host-pinned-api-token-installation' = sentryResult.provenance.credentialBinding
    const item: ReconciledSentryItem = sentryResult.item
    void revision; void binding; void item
  }

  const apmResult = await reconcileApmSource(apmOptions)
  type ConcreteApmResult = Assert<Equal<IsAny<typeof apmResult>, false>>
  const checkedApm: ConcreteApmResult = true
  if (apmResult.decision === 'trusted') {
    const protocol: 'gasteam-apm-current/v1' = apmResult.provenance.protocol
    const senderId: string = apmResult.provenance.senderId
    const item: ReconciledApmItem = apmResult.item
    void protocol; void senderId; void item
  }

  const readResult = await readMonitoringResource(readOptions, async ctx => {
    type ConcreteContext = Assert<Equal<IsAny<typeof ctx>, false>>
    const checkedCtx: ConcreteContext = true
    const checkedAt: string = ctx.checkedAt
    void checkedCtx; void checkedAt
    return { status: 'ok' }
  })
  type ConcreteReadResult = Assert<Equal<IsAny<typeof readResult>, false>>
  const checkedRead: ConcreteReadResult = true

  const failure = new MonitoringProviderFailure('SOURCE_DENIED', 'DIAGNOSTIC')
  const failureReason: MonitoringReason = failure.reason

  const sentryLookup = sentryReconciliationLookupSchema.parse(rawLookup)
  type ConcreteSentryLookup = Assert<Equal<IsAny<typeof sentryLookup>, false>>
  const checkedSentryLookup: ConcreteSentryLookup = true

  const apmLookup = apmReconciliationLookupSchema.parse(rawLookup)
  type ConcreteApmLookup = Assert<Equal<IsAny<typeof apmLookup>, false>>
  const checkedApmLookup: ConcreteApmLookup = true

  // @ts-expect-error An invalid provider failure reason must be statically rejected
  new MonitoringProviderFailure('UNKNOWN_REASON', 'DIAGNOSTIC')

  // @ts-expect-error Sentry reconciliation options require a valid route and observed lookup
  await reconcileSentrySource({ route: sentryOptions.route })

  // @ts-expect-error APM reconciliation options require a valid route and observed lookup
  await reconcileApmSource({ route: apmOptions.route })

  // @ts-expect-error The DarkFactoryMonitoringReconciler constructor is private
  new DarkFactoryMonitoringReconciler(policy, host, [], new Map())

  return {
    checkedReconciler,
    checkedSentry,
    checkedApm,
    checkedRead,
    checkedSentryLookup,
    checkedApmLookup,
    failureReason,
    sentryKind: sentryLookup.kind,
    apmKind: apmLookup.kind,
  }
}
