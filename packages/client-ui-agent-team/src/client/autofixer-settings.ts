/** Client-safe Autofixer configuration, prompt generator, and template models. */

export type AutofixerTargetScope = 'workspace' | 'project'
export type AutofixerScheduleMode = 'nightly' | 'continuous_cicd' | 'instant_p0' | 'custom'
export type AutofixerP0Action = 'instant_dispatch' | 'escalate_only'
export type AutofixerP1Action = 'scheduled_cicd' | 'plan_only'
export type AutofixerP2Action = 'plan_only' | 'ignore'
export type AutofixerDowntimeAction = 'quarantine_and_escalate' | 'dry_run_only'

export interface AutofixerVerificationGates {
  readonly doctor: boolean
  readonly docs: boolean
  readonly typecheck: boolean
  readonly build: boolean
  readonly test: boolean
  readonly smoke: boolean
  readonly acceptance: boolean
}

export interface AutofixerConfig {
  readonly enabled: boolean
  readonly targetScope: AutofixerTargetScope
  readonly projectId?: string | undefined
  readonly scheduleMode: AutofixerScheduleMode
  readonly cronExpression: string
  readonly p0Action: AutofixerP0Action
  readonly p1Action: AutofixerP1Action
  readonly p2Action: AutofixerP2Action
  readonly productionDowntimeToleranceMinutes: number
  readonly downtimeExceededAction: AutofixerDowntimeAction
  readonly worktreeIsolation: boolean
  readonly maxRemediationAttempts: number
  readonly verificationGates: AutofixerVerificationGates
}

export const DEFAULT_AUTOFIXER_CONFIG: AutofixerConfig = {
  enabled: true,
  targetScope: 'workspace',
  projectId: undefined,
  scheduleMode: 'instant_p0',
  cronExpression: '0 21 * * *',
  p0Action: 'instant_dispatch',
  p1Action: 'scheduled_cicd',
  p2Action: 'plan_only',
  productionDowntimeToleranceMinutes: 15,
  downtimeExceededAction: 'quarantine_and_escalate',
  worktreeIsolation: true,
  maxRemediationAttempts: 2,
  verificationGates: {
    doctor: true,
    docs: true,
    typecheck: true,
    build: true,
    test: true,
    smoke: true,
    acceptance: false,
  },
}

export const AUTOFIXER_PRESETS: Record<'nightly' | 'continuous' | 'instant_p0', Partial<AutofixerConfig>> = {
  nightly: {
    scheduleMode: 'nightly',
    cronExpression: '0 21 * * *',
    p0Action: 'instant_dispatch',
    p1Action: 'scheduled_cicd',
    p2Action: 'plan_only',
    productionDowntimeToleranceMinutes: 30,
    downtimeExceededAction: 'quarantine_and_escalate',
    worktreeIsolation: true,
    maxRemediationAttempts: 2,
  },
  continuous: {
    scheduleMode: 'continuous_cicd',
    cronExpression: '0 * * * *',
    p0Action: 'instant_dispatch',
    p1Action: 'scheduled_cicd',
    p2Action: 'plan_only',
    productionDowntimeToleranceMinutes: 5,
    downtimeExceededAction: 'quarantine_and_escalate',
    worktreeIsolation: true,
    maxRemediationAttempts: 1,
  },
  instant_p0: {
    scheduleMode: 'instant_p0',
    cronExpression: '0 21 * * *',
    p0Action: 'instant_dispatch',
    p1Action: 'scheduled_cicd',
    p2Action: 'plan_only',
    productionDowntimeToleranceMinutes: 15,
    downtimeExceededAction: 'quarantine_and_escalate',
    worktreeIsolation: true,
    maxRemediationAttempts: 2,
  },
}

export function generateAgentPrompt(config: AutofixerConfig): string {
  const target = config.targetScope === 'project' && config.projectId
    ? `registered project "${config.projectId}" in GasTeam`
    : 'GasTeam workspace (Silktex/dsh-gasteam)'

  const p0Text = config.p0Action === 'instant_dispatch'
    ? 'Instant autonomous dispatch in an isolated Git worktree; apply atomic remediation; rollback immediately if >2 attempts fail.'
    : 'Halt automated fix; log defect and escalate immediately to operator inbox via health.jsonl.'

  const p1Text = config.p1Action === 'scheduled_cicd'
    ? 'Remediate during next scheduled CI/CD cycle in a dedicated candidate worktree.'
    : 'Generate Plan of Fix report without automatic code modification.'

  const p2Text = config.p2Action === 'plan_only'
    ? 'Synthesize findings into reports/nightly-fix-plan-YYYY-MM-DD.md; do not commit changes.'
    : 'Ignore P2 warnings in automated gate evaluation.'

  const downtimeText = config.productionDowntimeToleranceMinutes === 0
    ? 'Zero-downtime policy (Blue-Green / Hot-Standby only). If any downtime is projected, do not touch production.'
    : `Maximum projected production downtime tolerance is ${config.productionDowntimeToleranceMinutes} minute(s). If remediation is projected to exceed this limit, ${
        config.downtimeExceededAction === 'quarantine_and_escalate'
          ? 'quarantine the candidate worktree and escalate to operator inbox via health.jsonl.'
          : 'generate Plan of Fix only without modifying production.'
      }`

  const gates = [
    config.verificationGates.doctor && 'pnpm doctor',
    config.verificationGates.docs && 'pnpm check:docs',
    config.verificationGates.typecheck && 'pnpm typecheck',
    config.verificationGates.build && 'pnpm build',
    config.verificationGates.test && 'pnpm test',
    config.verificationGates.smoke && 'pnpm test:smoke',
    config.verificationGates.acceptance && 'pnpm test:acceptance',
  ].filter(Boolean).map(cmd => `- \`${cmd}\``).join('\n')

  return `Objective: Autonomous CI/CD Review & Self-Healing for ${target}.

Runbook: Follow all execution instructions in autofixer.md.

Multi-Agent Safety & Isolation Invariants:
- Anti-Clobber Worktree Isolation: ${config.worktreeIsolation ? 'MANDATORY. Never edit files in the shared checkout. Always create an isolated Git worktree (e.g. feat/autofix-<date>).' : 'Standard working tree.'}
- Shell Environment: Ensure export TMPDIR=/var/tmp (to prevent /tmp inode exhaustion) and export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH.
- Non-Destructive Operation: NEVER run git reset --hard or git clean -fd on shared branches.

Triage & Severity Execution Policy:
- P0 (Blocker): ${p0Text}
- P1 (Regression): ${p1Text}
- P2 (Flakiness / Docs): ${p2Text}

Production Downtime Limit:
- ${downtimeText}
- Max self-healing attempts before auto-rollback: ${config.maxRemediationAttempts}.

Active Verification Gates:
${gates}

Deliverables:
1. Defect triage ledger and root cause diagnosis.
2. Plan of Fix report at reports/nightly-fix-plan-YYYY-MM-DD.md.
3. Verified atomic fixes on dedicated fix branch (if authorized by severity policy).`
}

export function generateCrontabCommand(config: AutofixerConfig, repoPath = '/home/dsh/projects/gasteam'): string {
  const cron = config.scheduleMode === 'continuous_cicd'
    ? '0 * * * *'
    : config.scheduleMode === 'instant_p0'
      ? '0 21 * * *'
      : config.cronExpression
  const flag = config.verificationGates.acceptance ? ' --full' : ''
  return `${cron} cd ${repoPath} && export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH && export TMPDIR=/var/tmp && pnpm autofix${flag} >> /var/tmp/autofixer-cron.log 2>&1`
}

export function generateSystemdService(config: AutofixerConfig, repoPath = '/home/dsh/projects/gasteam'): string {
  const flag = config.verificationGates.acceptance ? ' --full' : ''
  return `[Unit]
Description=GasTeam Autofixer & CI/CD Self-Healing Agent
After=network.target

[Service]
Type=oneshot
WorkingDirectory=${repoPath}
Environment="PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
Environment="TMPDIR=/var/tmp"
ExecStart=/bin/bash -c 'pnpm autofix${flag}'
`
}

export function generateSystemdTimer(config: AutofixerConfig): string {
  const calendar = config.scheduleMode === 'continuous_cicd'
    ? 'hourly'
    : '*-*-* 21:00:00'
  return `[Unit]
Description=Trigger GasTeam Autofixer (${config.scheduleMode})

[Timer]
OnCalendar=${calendar}
Persistent=true

[Install]
WantedBy=timers.target
`
}

export function generateCicdStep(config: AutofixerConfig): string {
  const scopeComment = config.targetScope === 'project' && config.projectId
    ? `Target Project: ${config.projectId}`
    : 'Target: GasTeam Workspace'
  return `# GasTeam Autofixer CI/CD Step (${scopeComment})
# Severity: P0=${config.p0Action}, Downtime tolerance=${config.productionDowntimeToleranceMinutes}m
- name: GasTeam Autofixer & Doctor Gate
  env:
    TMPDIR: /var/tmp
    PATH: /home/linuxbrew/.linuxbrew/bin:$PATH
  run: |
    pnpm doctor
    pnpm autofix --quick
`
}

const STORAGE_PREFIX = 'gasteam.autofixer.config'

export function getStorageKey(scope: AutofixerTargetScope, projectId?: string): string {
  return scope === 'project' && projectId ? `${STORAGE_PREFIX}.project.${projectId}` : `${STORAGE_PREFIX}.workspace`
}

export function loadStoredAutofixerConfig(scope: AutofixerTargetScope, projectId?: string): AutofixerConfig {
  try {
    if (typeof localStorage !== 'undefined') {
      const key = getStorageKey(scope, projectId)
      const raw = localStorage.getItem(key)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as Partial<AutofixerConfig>
        return {
          ...DEFAULT_AUTOFIXER_CONFIG,
          ...parsed,
          targetScope: scope,
          projectId: scope === 'project' ? (projectId ?? parsed.projectId) : undefined,
          verificationGates: {
            ...DEFAULT_AUTOFIXER_CONFIG.verificationGates,
            ...parsed.verificationGates,
          },
        }
      }
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
  return {
    ...DEFAULT_AUTOFIXER_CONFIG,
    targetScope: scope,
    projectId: scope === 'project' ? projectId : undefined,
  }
}

export function saveStoredAutofixerConfig(config: AutofixerConfig): void {
  try {
    if (typeof localStorage !== 'undefined') {
      const key = getStorageKey(config.targetScope, config.projectId)
      localStorage.setItem(key, JSON.stringify(config))
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}
