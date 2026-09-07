import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dependabotAlertFixture } from './dependabot-reconciliation-fixture.ts'
import { enabledPolicy } from './config-fixture.ts'
import { githubReconciliationRegistrationSchema } from '../../src/darkfactory/config.ts'
import { DarkFactoryReconciler } from '../../src/darkfactory/reconciliation.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { HealthStore } from '../../src/health.ts'
import { runGit } from '../../src/git-command.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
const cleanups: (()=>Promise<void>)[]=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup()})
async function fixture(count=1, kind: 'issue' | 'pull_request' | 'dependabot_alert' = 'issue') {
 const directory=await mkdtemp(join(tmpdir(),'factory-reconciliation-'))
 cleanups.push(()=>rm(directory,{recursive:true,force:true}))
 await runGit(directory,['init','--quiet'],new AbortController().signal,5000)
 await runGit(directory,['remote','add','origin','https://github.com/owner/repo.git'],new AbortController().signal,5000)
 const policy=enabledPolicy(), route=policy.ingestion.routes[0]!
 if(route.source!=='github')throw new Error('fixture')
 route.repositoryIds=['42'];route.senderIds=['12'];route.bindings={installationIds:['10'],authorIds:['12'],automationRules:[{ruleId:'rule',automationLabel:'automate'}]}
 route.reconciliation=githubReconciliationRegistrationSchema.parse({installationId:'10',repositoryId:'42',repositoryName:'owner/repo',credentialRef:{kind:'env',name:'FIXTURE_TOKEN'},credentialKind:'installation-token'})
 if(kind==='dependabot_alert'){route.bindings.authorIds=['host-sensor:dependabot'];route.reconciliation.dependabot={sensorPrincipalId:'host-sensor:dependabot',ruleId:'rule'}}
 const options={projectId:'project',maxBodyBytes:10000,maxQueueItems:100}
 let store=await DarkFactoryIngestionStore.open(directory,options)
 cleanups.push(()=>store.close())
 const artifacts=await DarkFactoryArtifactStore.open(directory,['project'],1_048_576,16_777_216)
 const health=await HealthStore.open(directory,{dshDeadlineMs:1000,externalDeadlineMs:1000,escalationCooldownMs:1000,maxEscalationsPerCondition:2})
 cleanups.push(()=>health.close())
 let allowed=true, token='fixture-installation-token', issueHook: (()=>Promise<void>) | undefined
 const authorizations: string[]=[]
 let now=Date.parse('2026-09-06T12:01:00Z'), status=200, calls=0, label=true, alertState='open'
 for(let index=0;index<count;index++){
  const artifact=await artifacts.persist('project',{lookup:{kind,...(kind==='pull_request'?{baseRepositoryId:'42',headRepositoryId:'42',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),fork:false}:{}),sourceEntityId:kind==='dependabot_alert'?`dependabot:42:${index+1}`:`${kind==='issue'?'issue':'pr'}:42:${100+index}`,providerEntityId:String(kind==='dependabot_alert'?index+1:100+index),repositoryId:'42',actorId:'12',installationId:'10',number:index+1}})
  await store.recordReceived({bodySizeBytes:20,envelope:{schemaVersion:1,id:`envelope:${index}`,projectId:'project',policyRevision:1,source:'github',adapterVersion:route.providerVersion,routeId:route.id,deliveryId:`delivery-${index}`,eventKind:kind==='issue'?'issues':kind==='pull_request'?'pull_request':'dependabot_alert',action:kind==='dependabot_alert'?'created':'opened',bodyDigest:digestJson({index}),receivedAt:new Date(now).toISOString(),signingKeyId:route.signingKeyId,authentication:'verified',artifact}})
 }
 const stores=new Map([['project',store]])
 const open=()=>DarkFactoryReconciler.open(policy,{projects:[{id:'project',repository:directory}],stores,artifacts,clock:()=>now,resolveSecret:async()=>token,authorize:async()=>{if(!allowed)throw new Error('authority revoked')},
  quarantine:async input=>(await health.raiseFactoryEscalation({schemaVersion:1,projectId:input.projectId,policyRevision:1,stage:'ingress',reason:input.reason,effectId:input.envelopeId,evidenceRefs:[input.envelopeId],severity:'warning',diagnostics:input.reason},now)).id,
  transport:async (url,init)=>{
   calls++
   authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
   if(!String(url).includes('/installation/repositories'))await issueHook?.()
   if(status!==200)return new Response('unavailable',{status})
   const number=Number(String(url).split('/').at(-1))
   return new Response(JSON.stringify(String(url).includes('/installation/repositories')?{total_count:1,repositories:[{id:42,full_name:'owner/repo'}]}:kind==='dependabot_alert'?{...dependabotAlertFixture(number),state:alertState}:{...(kind==='pull_request'?{merged:false,draft:false,base:{repo:{id:42,full_name:'owner/repo'},sha:'a'.repeat(40),ref:'main'},head:{repo:{id:42,full_name:'owner/repo'},sha:'b'.repeat(40),ref:'repair'}}:{}),id:99+number,number,title:'Empty requests crash',body:'Expected success. secret=fixture-installation-token',user:{id:12},labels:label?[{id:3,name:'automate'}]:[],state:'open',updated_at:'2026-09-06T12:00:00Z'}),{headers:{'content-type':'application/json'}})
  }})
 let reconciler=await open()
 cleanups.push(()=>reconciler.close())
 return {get store(){return store},get reconciler(){return reconciler},health,artifacts,get calls(){return calls},authorizations,rotate(value:string){token=value},revoke(){allowed=false},blockIssue(){let release!:()=>void,entered!:()=>void;const seen=new Promise<void>(resolve=>{entered=resolve});const wait=new Promise<void>(resolve=>{release=resolve});issueHook=async()=>{entered();await wait};return {entered:seen,release}},setStatus(value:number){status=value},removeLabel(){label=false},closeAlert(){alertState='dismissed'},advance(ms=300_001){now+=ms},
  async reopen(){await reconciler.close();await store.close();store=await DarkFactoryIngestionStore.open(directory,options);stores.set('project',store);reconciler=await open()}}
}
it.each(['issue','pull_request','dependabot_alert'] as const)('reconciles %s authority after durable custody without changing the original receipt',async(kind)=>{
 const f=await fixture(1,kind);const receipt=f.store.snapshot().custody[0]!.receipt
 await f.reconciler.runOnce()
 expect(f.store.snapshot().reconciliations[0]).toMatchObject({status:'resolved',attempts:1})
 expect(f.store.snapshot().items).toHaveLength(1)
 expect(f.store.snapshot().items[0]).toMatchObject({state:'trusted',revision:2,trust:{decision:'trusted'}})
 expect(JSON.stringify(f.store.snapshot())).not.toContain('fixture-installation-token')
 expect(f.store.snapshot().custody[0]!.receipt).toEqual(receipt)
 await f.reopen();await f.reconciler.runOnce();expect(f.calls).toBe(2)
})
it('persists provider outage leases across reopen and quarantines exhausted attempts in the actual inbox',async()=>{
 const f=await fixture();f.setStatus(503)
 await f.reconciler.runOnce();expect(f.store.snapshot().items).toEqual([])
 await f.reopen();await f.reconciler.runOnce();expect(f.calls).toBe(1)
 for(let attempt=0;attempt<2;attempt++){f.advance();await f.reconciler.runOnce()}
 expect(f.store.snapshot().reconciliations[0]).toMatchObject({status:'quarantined',attempts:3,lastReason:'RECONCILIATION_EXHAUSTED'})
 expect(f.health.listEscalations()).toHaveLength(1)
})
it('recovers death-equivalent failure between attachment and trust without replacing pinned attachment input',async()=>{
 const f=await fixture();const transition=f.store.transition.bind(f.store)
 f.store.transition=async()=>{throw new Error('fixture interruption after attachment')}
 await f.reconciler.runOnce()
 expect(f.store.snapshot().items[0]?.state).toBe('received')
 const attachment=f.store.snapshot().attachments[0]
 f.store.transition=transition
 await f.reopen();f.advance();await f.reconciler.runOnce()
 expect(f.store.snapshot().items[0]?.state).toBe('trusted')
 expect(f.store.snapshot().attachments).toEqual([attachment])
 expect(f.store.snapshot().reconciliations[0]?.status).toBe('resolved')
})
it('rejects current source revocation with a durable inbox reference',async()=>{
 const f=await fixture();f.removeLabel();await f.reconciler.runOnce()
 expect(f.store.snapshot().items).toEqual([])
 expect(f.store.snapshot().reconciliations[0]).toMatchObject({status:'quarantined',lastReason:'SOURCE_DENIED'})
 expect(f.health.listEscalations()).toHaveLength(1)
})
it('retains conservative local provider request reservations across restart',async()=>{
 const f=await fixture(6);await f.reconciler.runOnce()
 expect(f.calls).toBe(10)
 expect(f.store.snapshot().items).toHaveLength(5)
 await f.reopen();await f.reconciler.runOnce();expect(f.calls).toBe(10)
 f.advance(60_001);await f.reconciler.runOnce();expect(f.calls).toBe(12)
 expect(f.store.snapshot().items).toHaveLength(6)
})

it('rechecks host authority after a pending provider response before marking work trusted',async()=>{
 const f=await fixture();const block=f.blockIssue();const running=f.reconciler.runOnce()
 await block.entered;f.revoke();block.release();await running
 expect(f.store.snapshot().items).toEqual([])
 expect(f.store.snapshot().reconciliations[0]).toMatchObject({status:'quarantined',lastReason:'AUTHORITY_UNRESOLVED'})
 expect(f.health.listEscalations()).toHaveLength(1)
})
it('refreshes the pinned credential reference between attempts and keeps old credentials out of persisted prose',async()=>{
 const f=await fixture();f.setStatus(503);await f.reconciler.runOnce()
 f.rotate('replacement-installation-token');f.setStatus(200);f.advance();await f.reconciler.runOnce()
 expect(f.authorizations).toEqual(['Bearer fixture-installation-token','Bearer replacement-installation-token','Bearer replacement-installation-token'])
 expect(f.store.snapshot().items[0]?.state).toBe('trusted')
 expect(JSON.stringify(f.store.snapshot())).not.toContain('fixture-installation-token')
})

it('denies a dismissed current Dependabot alert after authenticated custody',async()=>{
 const f=await fixture(1,'dependabot_alert');f.closeAlert();await f.reconciler.runOnce()
 expect(f.store.snapshot().items).toEqual([])
 expect(f.store.snapshot().reconciliations[0]).toMatchObject({status:'quarantined',lastReason:'SOURCE_DENIED'})
 expect(f.health.listEscalations()).toHaveLength(1)
})
it('records Dependabot sensor authority distinctly from provider-attested human author claims',async()=>{
 const f=await fixture(1,'dependabot_alert');await f.reconciler.runOnce()
 const item=f.store.snapshot().items[0]!
 expect(item).toMatchObject({author:'host-sensor:dependabot',actor:'host-sensor:dependabot',labels:['automate'],trust:{reasons:['CURRENT_PROVIDER_ALERT_VERIFIED','HOST_REGISTERED_SENSOR_RULE']}})
 expect(await f.artifacts.read(item.provenance[1]!)).toMatchObject({identityBinding:'host-configured-dependabot-sensor',webhookActorId:'12'})
})
