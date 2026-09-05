/** Event-backed project registration. The coordinator must own the directory before opening it. */
import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import z from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { runGit } from './git-command.ts'
import { DurableJournal } from './durable-journal.ts'

export type ProjectId = Branded<'ProjectId'>
export type RepositoryId = Branded<'RepositoryId'>
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const text = z.string().trim().min(1).max(4096)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const absolutePath = text.refine(isAbsolute, 'Expected absolute path')
const verification = z.object({
  revision: positive,
  commands: z.array(z.object({ command: text, args: z.array(z.string().max(16_384)).max(256) }).strict()).min(1).max(64),
}).strict()
const registration = z.object({
  id: identifier,
  repository: absolutePath,
  targetBranch: text,
  teamIds: z.array(identifier).min(1).max(256).refine(ids => new Set(ids).size === ids.length, 'Duplicate team IDs'),
  capacity: positive,
  verification,
}).strict()
const projectSchema = registration.extend({ repositoryId: absolutePath, revision: z.literal(1) })
const eventSchema = z.object({
  version: z.literal(1), sequence: positive, type: z.literal('project/registered'), project: projectSchema,
}).strict()

export type RegisterProjectRequest = z.input<typeof registration>
export type ProjectRecord = Omit<z.output<typeof projectSchema>, 'id' | 'repositoryId'> & {
  readonly id: ProjectId
  readonly repositoryId: RepositoryId
}

/** Check uniqueness both on admission and replay. */
function assertAvailable(projects: ProjectRecord[], project: { id: string; teamIds: string[]; targetBranch: string; repositoryId?: string }): void {
  for (const existing of projects) {
    if (existing.id === project.id) throw new Error(`Project ${project.id} is already registered`)
    if (existing.teamIds.some(id => project.teamIds.includes(id))) throw new Error('Team is already registered to a project')
    if (project.repositoryId !== undefined && existing.repositoryId === project.repositoryId && existing.targetBranch === project.targetBranch) {
      throw new Error('Repository and target are already registered to a project; attach teams to its existing owner')
    }
  }
}

type ProjectEvent = { type: 'project/registered'; project: ProjectRecord }

/** Append-only authority for project policy and team discovery; task contents stay in session logs. */
export class ProjectCatalog {
  private constructor(private readonly journal: DurableJournal<ProjectRecord[], ProjectEvent>) {}

  static async open(directory: string): Promise<ProjectCatalog> {
    return new ProjectCatalog(await DurableJournal.open<ProjectRecord[], ProjectEvent>(join(directory, 'projects.jsonl'), [], (projects, raw) => {
      const event = eventSchema.parse(raw)
      assertAvailable(projects, event.project)
      return [...projects, event.project as ProjectRecord]
    }))
  }

  /** Register before accepting tasks in any referenced team. Duplicate identities are never reused. */
  async register(request: RegisterProjectRequest): Promise<ProjectRecord> {
    const input = registration.parse(request)
    const projects = await this.journal.append(async projects => {
      assertAvailable(projects, input)
      const signal = new AbortController().signal
      await runGit(input.repository, ['check-ref-format', `refs/heads/${input.targetBranch}`], signal, 10_000)
      const repository = await realpath(await runGit(input.repository, ['rev-parse', '--show-toplevel'], signal, 10_000))
      const repositoryId = await realpath(await runGit(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal, 10_000))
      const project = { ...input, repository, repositoryId, revision: 1 } as ProjectRecord
      assertAvailable(projects, project)
      await runGit(repository, ['show-ref', '--verify', `refs/heads/${input.targetBranch}`], signal, 10_000)
      return { type: 'project/registered', project }
    })
    return projects.at(-1)!
  }

  list(): ProjectRecord[] { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }
}
