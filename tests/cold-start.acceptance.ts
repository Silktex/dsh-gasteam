import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { processFixture } from './support/process-fixture.ts'

it.each([false, true])('discovers persisted work without opening its Lead and preserves pause=%s', async (paused) => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-restart-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const first = processFixture(paused ? 'seed-paused' : 'seed', directory)
    processes.push(first)
    const persisted = await first.barrier<{ barrier: string; rootId: string; taskId: string; pid: number; coordinatorId: string }>()
    expect(persisted.barrier).toBe('persisted')
    await first.stop(true)
    processes.pop()
    const second = processFixture('restore', directory)
    processes.push(second)
    const restored = await second.barrier<{
      barrier: string; pid: number; persistedTasks: { id: string; status: string; blockedBy: string[] }[]
      discoveredTasks: { teamId: string; taskId: string }[]
      liveAgents: number; coordinatorId: string
      projectControls: { paused: boolean; revision: number }[]
    }>()
    expect(restored.barrier).toBe('startup')
    expect(restored.pid).not.toBe(persisted.pid)
    expect(restored.liveAgents).toBe(0)
    expect(restored.coordinatorId).toBe(persisted.coordinatorId)
    expect(restored.projectControls).toEqual([{ paused, revision: paused ? 1 : 0 }])
    expect(restored.persistedTasks).toEqual([expect.objectContaining({
      id: persisted.taskId, status: 'pending', blockedBy: [],
    })])
    expect(restored.discoveredTasks, 'Startup must discover ready work and keep operator-paused work paused')
      .toEqual(paused ? [] : [{ teamId: persisted.rootId, taskId: persisted.taskId }])
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)

it('restarts a real-Git gated code workflow after verified candidate and promotes only after a fresh reviewer receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-code-workflow-process-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const crashed = processFixture('seed-code-workflow', directory); processes.push(crashed)
    const verified = await crashed.barrier<{ barrier: string; job: { id: string; phase: string }; tasks: { reviewGate?: string }[] }>()
    expect(verified).toMatchObject({ barrier: 'code-verified', job: { phase: 'verified' } })
    expect(verified.tasks[0]!.reviewGate).toBeTruthy()
    await crashed.stop(true); processes.pop()
    const restored = processFixture('restore-code-review', directory); processes.push(restored)
    const complete = await restored.barrier<{ barrier: string; workflows: { executionId: string; steps: { phase: string }[] }[]; submissions: { phase: string }[]; integrations: { phase: string }[] }>()
    expect(complete.barrier).toBe('code-completed')
    expect(complete.workflows.find(value => value.executionId === 'code-workflow-process')!.steps.every(step => step.phase === 'completed')).toBe(true)
    expect(complete.submissions).toEqual([expect.objectContaining({ phase: 'accepted' })])
    expect(complete.integrations).toEqual([expect.objectContaining({ phase: 'merged' })])
  } finally { try { for (const process of processes.reverse()) await process.stop() } finally { await rm(directory, { recursive: true, force: true }) } }
}, 30_000)

it('keeps a real-Git candidate verified when its durable reviewer decision is rejected, including after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-code-workflow-rejected-process-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const crashed = processFixture('seed-code-workflow', directory); processes.push(crashed)
    const verified = await crashed.barrier<{ barrier: string; head: string }>()
    expect(verified.barrier).toBe('code-verified')
    await crashed.stop(true); processes.pop()
    const rejected = processFixture('restore-code-reject', directory); processes.push(rejected)
    const first = await rejected.barrier<{ barrier: string; workflows: { executionId: string; steps: { stepId: string; phase: string }[] }[]; tasks: { status: string }[]; reports: { decision?: string; phase: string }[]; submissions: { phase: string }[]; integrations: { phase: string }[]; head: string }>()
    expect(first.barrier).toBe('code-rejected')
    expect(first.workflows.find(value => value.executionId === 'code-workflow-process')!.steps).toContainEqual(expect.objectContaining({ stepId: 'review', phase: 'failed' }))
    expect(first.reports).toEqual([expect.objectContaining({ phase: 'accepted', decision: 'rejected' })])
    expect(first.submissions).toEqual([expect.objectContaining({ phase: 'queued' })])
    expect(first.integrations).toEqual([expect.objectContaining({ phase: 'verified' })])
    expect(first.tasks.some(task => task.status === 'pending')).toBe(true)
    expect(first.head).toBe(verified.head)
    await rejected.stop(true); processes.pop()
    const restarted = processFixture('restore-code-reject', directory); processes.push(restarted)
    const replay = await restarted.barrier<typeof first>()
    expect(replay.barrier).toBe('code-rejected')
    expect(replay.reports).toEqual([expect.objectContaining({ phase: 'accepted', decision: 'rejected' })])
    expect(replay.integrations).toEqual([expect.objectContaining({ phase: 'verified' })])
    expect(replay.tasks.some(task => task.status === 'pending')).toBe(true)
    expect(replay.head).toBe(verified.head)
  } finally { try { for (const process of processes.reverse()) await process.stop() } finally { await rm(directory, { recursive: true, force: true }) } }
}, 30_000)

it('repairs a failed real-Git code workflow and promotes only the fresh approved candidate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-code-workflow-repair-process-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const seed = processFixture('seed-code-workflow-repair', directory); processes.push(seed)
    const failed = await seed.barrier<{ barrier: string; submissions: { sourceCommit: string }[]; head: string }>()
    expect(failed.barrier).toBe('code-verification-failed')
    await seed.stop(true); processes.pop()
    const repaired = processFixture('restore-code-repair-review', directory); processes.push(repaired)
    const complete = await repaired.barrier<{ barrier: string; workflows: { steps: { phase: string }[] }[]; workflowJournal: string; tasks: { subject: string }[]; submissions: { sourceCommit: string; phase: string }[]; integrations: { phase: string }[]; head: string }>()
    expect(complete.barrier).toBe('code-completed')
    expect(complete.workflows[0]!.steps.every(step => step.phase === 'completed')).toBe(true)
    expect(complete.workflowJournal).toContain('workflow/source-reworked')
    expect(complete.submissions).toEqual([expect.objectContaining({ sourceCommit: failed.submissions[0]!.sourceCommit, phase: 'queued' }), expect.objectContaining({ phase: 'accepted' })])
    expect(complete.integrations).toEqual([expect.objectContaining({ phase: 'failed' }), expect.objectContaining({ phase: 'merged' })])
    expect(complete.tasks.filter(task => task.subject.startsWith('Implement '))).toHaveLength(1)
    expect(complete.head).not.toBe(failed.head)
  } finally { try { await Promise.allSettled(processes.reverse().map(process => process.stop(true))) } finally { await rm(directory, { recursive: true, force: true }) } }
}, 30_000)

it('automatically starts unopened accepted work in an isolated worktree after a process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-auto-restart-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const seed = processFixture('seed', directory)
    processes.push(seed)
    const accepted = await seed.barrier<{ taskId: string }>()
    await seed.stop(true)
    processes.pop()
    const restored = processFixture('restore-execution', directory)
    processes.push(restored)
    expect((await restored.barrier<{ barrier: string }>()).barrier).toBe('startup')
    const worker = await restored.barrier<{ barrier: string; attempts: { taskId: string; phase: string; generation: number }[]; workerCwd: string; repository: string }>()
    expect(worker.barrier).toBe('automatic-worker')
    expect(worker.attempts).toEqual([expect.objectContaining({ taskId: accepted.taskId, phase: 'active', generation: 1 })])
    expect(worker.workerCwd).toBeTruthy()
    expect(worker.workerCwd).not.toBe(worker.repository)
    expect(worker.workerCwd.startsWith(join(directory, 'workers'))).toBe(true)
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)

it.each(['task-receipt', 'promotion', 'ambiguous-promotion'] as const)('reconciles a crash after %s without another worker or merge', async (boundary) => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-acceptance-crash-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const seed = processFixture('seed', directory)
    processes.push(seed)
    await seed.barrier()
    await seed.stop(true)
    processes.pop()
    const executing = processFixture(boundary === 'task-receipt' ? 'restore-acceptance-crash' : boundary === 'promotion' ? 'restore-promotion-crash' : 'restore-ambiguous-promotion', directory)
    processes.push(executing)
    const receipt = await executing.barrier<{ barrier: string; task: { id: string; revision: number; status: string }; submissions: { id: string; phase: string }[]; integrations: { id: string; phase: string }[]; head: string; workerRequests: number }>()
    expect(receipt.barrier).toBe(boundary)
    expect(receipt.task.status).toBe(boundary === 'task-receipt' ? 'completed' : 'pending')
    expect(receipt.submissions).toEqual([expect.objectContaining({ phase: 'queued' })])
    expect(receipt.integrations).toEqual([expect.objectContaining({ phase: boundary === 'ambiguous-promotion' ? 'verified' : 'merged' })])
    expect(receipt.workerRequests).toBe(1)
    await executing.stop(true)
    processes.pop()
    const replay = processFixture('restore-acceptance', directory)
    processes.push(replay)
    const accepted = await replay.barrier<{ barrier: string; tasks: { id: string; revision: number; status: string }[]; submissions: { id: string; phase: string }[]; integrations: { id: string; phase: string }[]; attempts: unknown[]; head: string; workerRequests: number }>()
    expect(accepted.barrier).toBe('accepted-replay')
    expect(accepted.tasks).toEqual([expect.objectContaining({ id: receipt.task.id, revision: receipt.task.revision + (boundary === 'task-receipt' ? 0 : 1), status: 'completed' })])
    expect(accepted.submissions).toEqual([expect.objectContaining({ id: receipt.submissions[0]!.id, phase: 'accepted' })])
    expect(accepted.integrations).toEqual(receipt.integrations.map(job => ({ ...job, phase: 'merged' })))
    expect(accepted.attempts).toHaveLength(1)
    expect(accepted.head).toBe(receipt.head)
    expect(accepted.workerRequests).toBe(0)
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)

it.each(['report-intent', 'report-receipt'] as const)('replays non-code %s across a SIGKILL without another worker', async (boundary) => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-report-crash-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const seed = processFixture('seed-report', directory)
    processes.push(seed)
    await seed.barrier()
    await seed.stop(true)
    processes.pop()
    const crashed = processFixture(boundary === 'report-intent' ? 'restore-report-intent-crash' : 'restore-report-receipt-crash', directory)
    processes.push(crashed)
    const persisted = await crashed.barrier<{ barrier: string; reports: { phase: string }[]; tasks: { status: string; revision: number }[]; attempts: { attemptId: string }[] }>()
    expect(persisted.barrier).toBe(boundary)
    expect(persisted.reports).toEqual([expect.objectContaining({ phase: 'pending' })])
    expect(persisted.tasks[0]).toMatchObject({ status: boundary === 'report-intent' ? 'pending' : 'completed', revision: boundary === 'report-intent' ? 1 : 2 })
    await crashed.stop(true)
    processes.pop()
    const replay = processFixture('restore-report', directory)
    processes.push(replay)
    const restored = await replay.barrier<{ barrier: string; reports: { phase: string; attemptId: string }[]; tasks: { status: string; revision: number }[]; attempts: { attemptId: string }[] }>()
    expect(restored.barrier).toBe('report-replayed')
    expect(restored.reports).toEqual([expect.objectContaining({ phase: 'accepted', attemptId: persisted.attempts[0]!.attemptId })])
    expect(restored.tasks).toEqual([expect.objectContaining({ status: 'completed', revision: 2 })])
    expect(restored.attempts).toHaveLength(1)
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)

it('replays report-workflow task admission after SIGKILL without duplicate task or worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-workflow-process-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const crashed = processFixture('seed-workflow-crash', directory)
    processes.push(crashed)
    const sideEffect = await crashed.barrier<{ barrier: string; task: { id: string }; workflows: unknown[] }>()
    expect(sideEffect.barrier).toBe('workflow-task-side-effect')
    await crashed.stop(true)
    processes.pop()
    const restored = processFixture('restore-workflow', directory)
    processes.push(restored)
    const replay = await restored.barrier<{ barrier: string; workflows: { executionId: string; steps: { stepId: string; taskId?: string; phase: string }[] }[]; tasks: { id: string }[]; attempts: { taskId: string; generation: number }[] }>()
    expect(replay.barrier).toBe('workflow-replayed')
    const workflow = replay.workflows.find(value => value.executionId === 'workflow-process-crash')!
    expect(workflow.steps[0]).toMatchObject({ stepId: 'investigate', taskId: sideEffect.task.id, phase: 'running' })
    expect(replay.tasks.filter(task => task.id === sideEffect.task.id)).toHaveLength(1)
    expect(replay.attempts.filter(attempt => attempt.taskId === sideEffect.task.id)).toEqual([expect.objectContaining({ generation: 1 })])
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)

it('completes a persisted diamond DAG on the built coordinator timer without browser or dispatch calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-dag-process-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const seed = processFixture('seed-dag', directory)
    processes.push(seed)
    await seed.barrier()
    await seed.stop(true)
    processes.pop()
    const executing = processFixture('restore-dag', directory)
    processes.push(executing)
    const completed = await executing.barrier<{ tasks: { status: string }[]; submissions: { phase: string }[]; integrations: { phase: string }[]; attempts: { generation: number }[]; workerRequests: number }>()
    expect(completed.tasks).toHaveLength(4)
    expect(completed.tasks.every(task => task.status === 'completed')).toBe(true)
    expect(completed.submissions).toHaveLength(4)
    expect(completed.submissions.every(submission => submission.phase === 'accepted')).toBe(true)
    expect(completed.integrations).toHaveLength(4)
    expect(completed.integrations.every(job => job.phase === 'merged')).toBe(true)
    expect(completed.attempts).toHaveLength(4)
    expect(completed.attempts.every(attempt => attempt.generation === 1)).toBe(true)
    expect(completed.workerRequests).toBe(4)
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)

it.each([false, true])('resumes an interrupted worker after SIGKILL with preserved worktree edits and dependent DAG=%s', async (dag) => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-worker-resume-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const seed = processFixture(dag ? 'seed-dag' : 'seed', directory)
    processes.push(seed)
    await seed.barrier()
    await seed.stop(true)
    processes.pop()
    const first = processFixture('restore-worker-crash', directory)
    processes.push(first)
    await first.barrier()
    const interrupted = await first.barrier<{ attempts: { attemptId: string; runtimeId: string; generation: number }[]; workerCwd: string }>()
    await first.stop(true)
    processes.pop()
    const resumed = processFixture('restore-worker-recovery', directory)
    processes.push(resumed)
    const finished = await resumed.barrier<{ attempts: { attemptId: string; runtimeId: string; generation: number; recovery: { count: number } }[]; tasks: { status: string }[]; submissions: { phase: string }[]; workerRequests: number; initial: string }>()
    expect(finished.attempts).toHaveLength(dag ? 4 : 1)
    expect(finished.attempts[0]).toMatchObject({ attemptId: interrupted.attempts[0]!.attemptId, runtimeId: interrupted.attempts[0]!.runtimeId, generation: interrupted.attempts[0]!.generation, phase: 'terminal', recovery: expect.objectContaining({ count: 1 }) })
    expect(finished.tasks).toHaveLength(dag ? 4 : 1)
    expect(finished.submissions).toHaveLength(dag ? 4 : 1)
    expect(finished.tasks.every(task => task.status === 'completed')).toBe(true)
    expect(finished.submissions.every(submission => submission.phase === 'accepted')).toBe(true)
    expect(finished.workerRequests).toBe(dag ? 4 : 1)
    expect(finished.initial).toBe('preserved interrupted edit')
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)


it('replays a durable stale-target retry in a fresh process with retained candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-stale-retry-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const seed = processFixture('seed', directory)
    processes.push(seed)
    await seed.barrier()
    await seed.stop(true)
    processes.pop()
    const executing = processFixture('restore-stale-target', directory)
    processes.push(executing)
    const receipt = await executing.barrier<{ barrier: string; job: { id: string; sourceCommit: string; cwd: string; previousCandidates: { cwd: string }[] }; workerRequests: number }>()
    expect(receipt.barrier).toBe('stale-target')
    expect(receipt.workerRequests).toBe(1)
    await executing.stop(true)
    processes.pop()
    const replay = processFixture('restore-acceptance', directory)
    processes.push(replay)
    const accepted = await replay.barrier<{ integrations: { phase: string }[]; tasks: { status: string }[]; workerRequests: number; attempts: unknown[] }>()
    expect(accepted.integrations).toEqual([expect.objectContaining({ ...receipt.job, phase: 'merged' })])
    expect(accepted.tasks).toEqual([expect.objectContaining({ status: 'completed' })])
    expect(accepted.workerRequests).toBe(0)
    expect(accepted.attempts).toHaveLength(1)
    expect(await readFile(join(receipt.job.previousCandidates[0]!.cwd, 'retained.txt'), 'utf8')).toBe('retained candidate evidence')
    expect(await readFile(join(directory, 'repository', 'external.txt'), 'utf8')).toBe('external target movement')
  } catch (error) {
    await Promise.allSettled(processes.splice(0).map(process => process.stop(true)))
    throw error
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)


it('restores a reserved repair with the same attempt, pinned budget, and original source artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-repair-process-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const seed = processFixture('seed-repair', directory)
    processes.push(seed)
    await seed.barrier()
    await seed.stop(true)
    processes.pop()
    const executing = processFixture('restore-repair-crash', directory)
    processes.push(executing)
    const receipt = await executing.barrier<{ barrier: string; attempts: { attemptId: string; runtimeId: string; phase: string; repairLimit: number; repair?: unknown }[]; submissions: unknown[]; integrations: { cwd: string }[] }>()
    expect(receipt.barrier).toBe('repair-reserved')
    expect(receipt.attempts).toHaveLength(2)
    expect(receipt.attempts[1]).toMatchObject({ phase: 'reserved', repairLimit: 1 })
    await executing.stop(true)
    processes.pop()
    const replay = processFixture('restore-repair', directory)
    processes.push(replay)
    const accepted = await replay.barrier<{ tasks: { status: string }[]; attempts: { attemptId: string; runtimeId: string; phase: string; repairLimit: number; repair?: unknown }[]; submissions: { phase: string }[]; workerRequests: number }>()
    expect(accepted.tasks).toEqual([expect.objectContaining({ status: 'completed' })])
    expect(accepted.attempts).toEqual([receipt.attempts[0], expect.objectContaining({ attemptId: receipt.attempts[1]!.attemptId,
      runtimeId: receipt.attempts[1]!.runtimeId, phase: 'terminal', repairLimit: 1, repair: receipt.attempts[1]!.repair })])
    expect(accepted.submissions).toEqual([receipt.submissions[0], expect.objectContaining({ phase: 'accepted' })])
    expect(accepted.workerRequests).toBe(1)
    expect(await readFile(join(receipt.integrations[0]!.cwd, `${receipt.attempts[0]!.attemptId}.txt`), 'utf8')).toBe('durable artifact\n')
    expect(await readFile(join(directory, 'repository', `${receipt.attempts[0]!.attemptId}.txt`), 'utf8')).toBe('durable artifact\n')
    expect(await readFile(join(directory, 'repository', 'repaired.txt'), 'utf8')).toBe('verified repair')
  } catch (error) {
    await Promise.allSettled(processes.splice(0).map(process => process.stop(true)))
    throw error
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)
