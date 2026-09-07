import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutofixerSettings } from '../src/client/AutofixerSettings.tsx'
import {
  generateAgentPrompt,
  generateCrontabCommand,
  generateSystemdService,
  generateSystemdTimer,
  generateCicdStep,
  DEFAULT_AUTOFIXER_CONFIG,
  type AutofixerConfig,
} from '../src/client/autofixer-settings.ts'
import { en, zh } from '../src/client/locales.ts'

const english = (key: keyof typeof en) => en[key]
const chinese = (key: keyof typeof zh) => zh[key]

const mockProjects = [
  { id: 'api', revision: 3, paused: false },
  { id: 'web', revision: 1, paused: false },
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (typeof localStorage !== 'undefined') {
    localStorage.clear()
  }
})

describe('AutofixerSettings & Prompt Helper', () => {
  it('renders all default controls, presets, and verification gates', () => {
    render(<AutofixerSettings projects={mockProjects} t={english} />)

    expect(screen.getByRole('heading', { name: new RegExp(en['autofixer.title']) })).toBeTruthy()
    expect(screen.getByText(en['autofixer.subtitle'])).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: en['autofixer.enabled'] })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en['autofixer.targetScope'] })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en['autofixer.scheduleMode'] })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en['autofixer.p0Action'] })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en['autofixer.p1Action'] })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en['autofixer.p2Action'] })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en['autofixer.downtimeTolerance'] })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en['autofixer.downtimeExceededAction'] })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: en['autofixer.worktreeIsolation'] })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: en['autofixer.maxAttempts'] })).toBeTruthy()

    // Presets
    expect(screen.getByRole('button', { name: en['autofixer.presetNightly'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['autofixer.presetContinuous'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['autofixer.presetInstantP0'] })).toBeTruthy()

    // Gates
    expect(screen.getByText(en['autofixer.gateDoctor'])).toBeTruthy()
    expect(screen.getByText(en['autofixer.gateDocs'])).toBeTruthy()
    expect(screen.getByText(en['autofixer.gateTypecheck'])).toBeTruthy()
    expect(screen.getByText(en['autofixer.gateBuild'])).toBeTruthy()
    expect(screen.getByText(en['autofixer.gateTest'])).toBeTruthy()
    expect(screen.getByText(en['autofixer.gateSmoke'])).toBeTruthy()
    expect(screen.getByText(en['autofixer.gateAcceptance'])).toBeTruthy()
  })

  it('generates customized agent prompt reflecting workspace target, P0 instant fix, and 15m downtime limit', () => {
    render(<AutofixerSettings projects={mockProjects} t={english} />)

    const code = screen.getByRole('region', { name: en['autofixer.promptHelper'] }).querySelector('code')
    expect(code).toBeTruthy()
    expect(code?.textContent).toContain('GasTeam workspace (Silktex/dsh-gasteam)')
    expect(code?.textContent).toContain('P0 (Blocker): Instant autonomous dispatch in an isolated Git worktree')
    expect(code?.textContent).toContain('Maximum projected production downtime tolerance is 15 minute(s)')
    expect(code?.textContent).toContain('Anti-Clobber Worktree Isolation: MANDATORY')
    expect(code?.textContent).toContain('export TMPDIR=/var/tmp')
  })

  it('switches target scope to specific project and updates generated prompt', () => {
    render(<AutofixerSettings projects={mockProjects} selectedProjectId="api" t={english} />)

    const targetScopeSelect = screen.getByRole('combobox', { name: en['autofixer.targetScope'] })
    fireEvent.change(targetScopeSelect, { target: { value: 'project' } })

    const projectSelect = screen.getByRole('combobox', { name: en['autofixer.projectId'] })
    fireEvent.change(projectSelect, { target: { value: 'api' } })

    const code = screen.getByRole('region', { name: en['autofixer.promptHelper'] }).querySelector('code')
    expect(code?.textContent).toContain('registered project "api" in GasTeam')
  })

  it('switches tabs to show crontab, systemd units, and CI/CD pipeline step', () => {
    render(<AutofixerSettings projects={mockProjects} t={english} />)

    const code = () => screen.getByRole('region', { name: en['autofixer.promptHelper'] }).querySelector('code')?.textContent

    // Tab Cron
    fireEvent.click(screen.getByRole('button', { name: en['autofixer.tabCron'] }))
    expect(code()).toContain('pnpm autofix')
    expect(code()).toContain('TMPDIR=/var/tmp')

    // Tab Systemd
    fireEvent.click(screen.getByRole('button', { name: en['autofixer.tabSystemd'] }))
    expect(code()).toContain('[Unit]')
    expect(code()).toContain('Description=GasTeam Autofixer')
    expect(code()).toContain('Description=Trigger GasTeam Autofixer')

    // Tab CI/CD
    fireEvent.click(screen.getByRole('button', { name: en['autofixer.tabCicd'] }))
    expect(code()).toContain('name: GasTeam Autofixer & Doctor Gate')
    expect(code()).toContain('pnpm doctor')
  })

  it('applies presets correctly', () => {
    render(<AutofixerSettings projects={mockProjects} t={english} />)

    // Continuous preset sets 5m downtime and continuous CI/CD mode
    fireEvent.click(screen.getByRole('button', { name: en['autofixer.presetContinuous'] }))
    const downtimeSelect = screen.getByRole('combobox', { name: en['autofixer.downtimeTolerance'] }) as HTMLSelectElement
    expect(downtimeSelect.value).toBe('5')

    // Nightly preset sets 30m downtime and nightly mode
    fireEvent.click(screen.getByRole('button', { name: en['autofixer.presetNightly'] }))
    expect(downtimeSelect.value).toBe('30')
  })

  it('adjusts zero-downtime policy and reflects in generated prompt', () => {
    render(<AutofixerSettings projects={mockProjects} t={english} />)

    const downtimeSelect = screen.getByRole('combobox', { name: en['autofixer.downtimeTolerance'] })
    fireEvent.change(downtimeSelect, { target: { value: '0' } })

    const code = screen.getByRole('region', { name: en['autofixer.promptHelper'] }).querySelector('code')
    expect(code?.textContent).toContain('Zero-downtime policy (Blue-Green / Hot-Standby only)')
  })

  it('saves configuration and invokes onSave callback', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<AutofixerSettings projects={mockProjects} onSave={onSave} t={english} />)

    fireEvent.click(screen.getByRole('button', { name: en['autofixer.save'] }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(en['autofixer.saved'])).toBeTruthy()
  })

  it('copies prompt to clipboard and shows visual confirmation', async () => {
    render(<AutofixerSettings projects={mockProjects} t={english} />)

    const copyBtn = screen.getByRole('button', { name: en['autofixer.copy'] })
    fireEvent.click(copyBtn)

    expect((await screen.findAllByText(en['autofixer.copied'])).length).toBeGreaterThan(0)
  })

  it('renders correctly with Chinese dictionary', () => {
    render(<AutofixerSettings projects={mockProjects} t={chinese} />)

    expect(screen.getByRole('heading', { name: new RegExp(zh['autofixer.title']) })).toBeTruthy()
    expect(screen.getByText(zh['autofixer.subtitle'])).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['autofixer.presetNightly'] })).toBeTruthy()
    expect(screen.getByText(zh['autofixer.gateDoctor'])).toBeTruthy()
  })
})

describe('Generator helper pure functions', () => {
  it('generates pure prompt, crontab, systemd, and cicd outputs according to configuration', () => {
    const customConfig: AutofixerConfig = {
      ...DEFAULT_AUTOFIXER_CONFIG,
      targetScope: 'project',
      projectId: 'my-service',
      scheduleMode: 'continuous_cicd',
      productionDowntimeToleranceMinutes: 0,
      downtimeExceededAction: 'dry_run_only',
      worktreeIsolation: true,
      maxRemediationAttempts: 1,
      verificationGates: {
        doctor: true,
        docs: true,
        typecheck: true,
        build: true,
        test: true,
        smoke: true,
        acceptance: true,
      },
    }

    const prompt = generateAgentPrompt(customConfig)
    expect(prompt).toContain('registered project "my-service"')
    expect(prompt).toContain('Zero-downtime policy')
    expect(prompt).toContain('Max self-healing attempts before auto-rollback: 1')
    expect(prompt).toContain('pnpm test:acceptance')

    const cron = generateCrontabCommand(customConfig, '/app')
    expect(cron).toContain('0 * * * * cd /app')
    expect(cron).toContain('pnpm autofix --full')

    const service = generateSystemdService(customConfig, '/app')
    expect(service).toContain('WorkingDirectory=/app')
    expect(service).toContain('pnpm autofix --full')

    const timer = generateSystemdTimer(customConfig)
    expect(timer).toContain('OnCalendar=hourly')

    const cicd = generateCicdStep(customConfig)
    expect(cicd).toContain('Target Project: my-service')
    expect(cicd).toContain('pnpm autofix --quick')
  })
})
