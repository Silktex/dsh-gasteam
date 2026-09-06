import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyToolCoordinator } from '../src/coordinator.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SystemDiagnosticsView } from '@deepseek-ai/dsh-experimental-agent-team/client'

describe('team_system_diagnostics tool', () => {
  it('registers team_system_diagnostics on lead agent and returns system diagnostics', async () => {
    const ctx = new Context()
    const registeredTools = new Map<string, { execute: (args: any, exec: any) => Promise<any> }>()

    const mockAgent: any = {
      id: 'agent-lead-1',
      session: { id: 'agent-lead-1', header: { parentSession: undefined } },
      ctx: {
        tools: {
          register(def: any) {
            registeredTools.set(def.name, def)
            return () => registeredTools.delete(def.name)
          },
        },
      },
    }

    ctx.provide('agents', {
      list: () => [mockAgent],
      get: () => mockAgent,
    })

    ctx.provide('agentTeams', {
      tryMembership: (agent: Agent) => agent === mockAgent ? { role: 'lead' } : undefined,
    })

    const sampleDiagnostics: SystemDiagnosticsView = {
      projectId: 'proj-1',
      healthy: true,
      paused: false,
      activeAttempts: 2,
      activeEscalations: [],
      recentErrors: [
        {
          timestamp: new Date().toISOString(),
          source: 'tool',
          message: 'Sample handled error',
        },
      ],
      blockedDispatches: 0,
    }

    ctx.provide('workspaceCoordinator', {
      systemDiagnostics: async (_caller: Agent, projectId: string) => {
        return { ...sampleDiagnostics, projectId }
      },
    })

    ctx.provide('tools', {})

    applyToolCoordinator(ctx)

    expect(registeredTools.has('team_system_diagnostics')).toBe(true)
    const tool = registeredTools.get('team_system_diagnostics')!

    const result = await tool.execute({ project_id: 'proj-1' }, { agent: mockAgent })
    expect(result.projectId).toBe('proj-1')
    expect(result.healthy).toBe(true)
    expect(result.activeAttempts).toBe(2)
    expect(result.recentErrors).toHaveLength(1)
    expect(result.recentErrors[0].message).toBe('Sample handled error')
  })
})
