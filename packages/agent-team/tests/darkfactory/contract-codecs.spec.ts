import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { bindTypertRemote, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { contracts } from '../../src/darkfactory/contracts/index.ts'
import { createFactoryContractCodec } from '../../src/darkfactory/contract-codecs.ts'
import { examples } from './fixtures.ts'
import type { IngressReceiptV1, CompilerOutcomeV1, AdmissionReceiptV1, MutantManifestV1, DeploymentRequestV1, DeploymentStatusV1, DeploymentCallbackV1, PricingSnapshotV1, ReservationV1 } from '../../src/darkfactory.ts'
// The codec type symbols must resolve to actual public SDK declarations.
const supportingFixtures: { IngressReceiptV1: IngressReceiptV1; CompilerOutcomeV1: CompilerOutcomeV1; AdmissionReceiptV1: AdmissionReceiptV1; MutantManifestV1: MutantManifestV1; DeploymentRequestV1: DeploymentRequestV1; DeploymentStatusV1: DeploymentStatusV1; DeploymentCallbackV1: DeploymentCallbackV1; PricingSnapshotV1: PricingSnapshotV1; ReservationV1: ReservationV1 } = examples
const require = createRequire(import.meta.url), dshRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const [{ default: Registry }, { default: Gateway }] = await Promise.all([
  import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-typert-registry')).href),
  import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-api-gateway')).href),
])
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
class Echo extends Service {
  readonly typertRemote = bindTypertRemote(this, 'factoryCodecFixture')
  calls = 0
  constructor(ctx: Context) { super(ctx, 'factoryCodecFixture') }
  echo(record: unknown) { this.calls++; return record }
}
async function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Registry); await ctx.plugin(Gateway); await ctx.plugin(Echo)
  const invocations: InvocationDescriptor[] = Object.keys(contracts).map(name => ({
    id: `factory-codec-fixture#factoryCodecFixture/${name}`, service: 'factoryCodecFixture', namespace: 'factoryCodecFixture', method: name,
    implementation: 'echo', invocation: { kind: 'direct' },
    parameters: [{ name: 'record', wire: 'record', source: 'json', codec: createFactoryContractCodec(name as keyof typeof contracts, 'project-1') }],
    result: createFactoryContractCodec(name as keyof typeof contracts, 'project-1'),
  }))
  const registry = ctx.get('typert') as { register(value: unknown): unknown }
  registry.register({ package: 'factory-codec-fixture', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations })
  const gateway = ctx.get('typertGateway') as { invoke(request: unknown): Promise<unknown> }
  return { echo: ctx.get('factoryCodecFixture') as Echo, gateway }
}
it('round-trips every public contract through the published DSH gateway and strict result codec', async () => {
  const { gateway, echo } = await fixture()
  for (const name of Object.keys(contracts) as (keyof typeof contracts)[]) {
    const codec = createFactoryContractCodec(name, 'project-1')
    const input = JSON.parse(JSON.stringify({ ...examples, ...supportingFixtures }[name]))
    const result = await gateway.invoke({ namespace: 'factoryCodecFixture', method: name, args: { record: input } })
    const received = codec.schema.parse(JSON.parse(JSON.stringify(result)))
    expect(received).toEqual(input)
  }
  expect(echo.calls).toBe(Object.keys(contracts).length)
})
it('round-trips provider-read custody and explicit host-scanner initiation through the actual gateway', async () => {
  const { gateway } = await fixture(), { signingKeyId: _key, ...fields } = examples.InboundEnvelopeV1
  const envelope = { ...fields, authentication: 'provider-api', bodyDigest: fields.artifact.digest,
    providerRead: { scannerId: 'host-scanner:fixture', ruleId: 'rule', requestReceiptId: 'request', responseDigest: fields.artifact.digest, observedAt: fields.receivedAt } }
  const item = { ...examples.InboundWorkItemV1, actor: 'host-scanner:fixture', initiator: { kind: 'host-scanner', scannerId: 'host-scanner:fixture', ruleId: 'rule' } }
  expect(await gateway.invoke({ namespace: 'factoryCodecFixture', method: 'InboundEnvelopeV1', args: { record: envelope } })).toEqual(envelope)
  expect(await gateway.invoke({ namespace: 'factoryCodecFixture', method: 'InboundWorkItemV1', args: { record: item } })).toEqual(item)
})
it('rejects cross-project records and secret-bearing extensions before service invocation with value-free errors', async () => {
  const { gateway, echo } = await fixture()
  const sentinel = 'fixture-private-credential-must-not-appear'
  for (const name of Object.keys(contracts) as (keyof typeof contracts)[]) {
    for (const input of [{ ...examples[name], projectId: 'different-project' }, { ...examples[name], credential: sentinel }]) {
      try {
        await gateway.invoke({ namespace: 'factoryCodecFixture', method: name, args: { record: input } })
        throw new Error('Fixture accepted invalid record')
      } catch (error) {
        expect(error).toMatchObject({ code: 'gateway/input-invalid' })
        expect(String(error)).not.toContain(sentinel)
      }
    }
  }
  expect(echo.calls).toBe(0)
})
it('rejects malformed nested references on both host and result decoding', async () => {
  const { gateway } = await fixture(), name = 'ExecutableSpecV1'
  const input = { ...examples[name], provenance: [{ ...examples[name].provenance[0], projectId: 'different-project' }] }
  await expect(gateway.invoke({ namespace: 'factoryCodecFixture', method: name, args: { record: input } })).rejects.toThrow()
  expect(() => createFactoryContractCodec(name, 'project-1').schema.parse(input)).toThrow(/^Invalid factory contract or project binding$/)
})
