/**
 * Autofixer and CI/CD settings panel with prompt helper and multi-project targeting.
 */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type AutofixerConfig,
  type AutofixerScheduleMode,
  type AutofixerTargetScope,
  type AutofixerP0Action,
  type AutofixerP1Action,
  type AutofixerP2Action,
  type AutofixerDowntimeAction,
  type AutofixerVerificationGates,
  DEFAULT_AUTOFIXER_CONFIG,
  AUTOFIXER_PRESETS,
  generateAgentPrompt,
  generateCrontabCommand,
  generateSystemdService,
  generateSystemdTimer,
  generateCicdStep,
  loadStoredAutofixerConfig,
  saveStoredAutofixerConfig,
} from './autofixer-settings.ts'
import type { TeamKey } from './locales.ts'
import css from './AutofixerSettings.module.css'

export interface AutofixerSettingsProps {
  readonly projects: readonly { readonly id: string; readonly revision: number; readonly paused: boolean }[]
  readonly selectedProjectId?: string | null | undefined
  readonly onSelectProject?: ((projectId: string | null) => void) | undefined
  readonly initialConfig?: Partial<AutofixerConfig> | undefined
  readonly onSave?: ((config: AutofixerConfig) => void | Promise<void>) | undefined
  readonly t: (key: TeamKey) => string
}

type TabKey = 'prompt' | 'cron' | 'systemd' | 'cicd'

export function AutofixerSettings({
  projects,
  selectedProjectId,
  onSelectProject,
  initialConfig,
  onSave,
  t,
}: AutofixerSettingsProps) {
  const [config, setConfig] = useState<AutofixerConfig>(() => {
    const scope: AutofixerTargetScope = selectedProjectId ? 'project' : 'workspace'
    const stored = loadStoredAutofixerConfig(scope, selectedProjectId ?? undefined)
    return {
      ...stored,
      ...initialConfig,
      verificationGates: {
        ...stored.verificationGates,
        ...initialConfig?.verificationGates,
      },
    }
  })

  const [activeTab, setActiveTab] = useState<TabKey>('prompt')
  const [copied, setCopied] = useState(false)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  // Update target project when operator explicitly changes dashboard selection and scope is project
  const applySelectedProject = useCallback(() => {
    if (!selectedProjectId) return
    setConfig(current => ({
      ...current,
      targetScope: 'project',
      projectId: selectedProjectId,
    }))
  }, [selectedProjectId])

  const applyPreset = useCallback((presetKey: keyof typeof AUTOFIXER_PRESETS) => {
    const preset = AUTOFIXER_PRESETS[presetKey]
    setConfig(current => ({
      ...current,
      ...preset,
    }))
  }, [])

  const handleSave = useCallback(async () => {
    saveStoredAutofixerConfig(config)
    if (onSave) {
      await onSave(config)
    }
    setSavedNotice(t('autofixer.saved'))
    setTimeout(() => {
      setSavedNotice(null)
    }, 4000)
  }, [config, onSave, t])

  const currentPreviewText = useCallback((): string => {
    switch (activeTab) {
      case 'prompt':
        return generateAgentPrompt(config)
      case 'cron':
        return generateCrontabCommand(config)
      case 'systemd':
        return `${generateSystemdService(config)}\n# ---\n${generateSystemdTimer(config)}`
      case 'cicd':
        return generateCicdStep(config)
    }
  }, [activeTab, config])

  const handleCopy = useCallback(async () => {
    const text = currentPreviewText()
    try {
      await writeClipboard(text)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 2500)
    } catch {
      // Ignore clipboard failure in restricted browsers
    }
  }, [currentPreviewText])

  const updateGate = useCallback((gate: keyof AutofixerVerificationGates, value: boolean) => {
    setConfig(current => ({
      ...current,
      verificationGates: {
        ...current.verificationGates,
        [gate]: value,
      },
    }))
  }, [])

  const targetProjectList = projects.map(p => p.id)
  const isTargetingProject = config.targetScope === 'project'

  return (
    <section className={css.root} aria-label={t('autofixer.title')}>
      <header className={css.header}>
        <div className={css.titleArea}>
          <h3>
            {t('autofixer.title')}
            <span className={config.enabled ? css.badge : `${css.badge} ${css.badgeDisabled}`}>
              {config.enabled ? t(`autofixer.schedule${config.scheduleMode === 'instant_p0' ? 'InstantP0' : config.scheduleMode === 'continuous_cicd' ? 'Continuous' : 'Nightly'}` as TeamKey) : t('autofixer.disabled')}
            </span>
          </h3>
          <p className={css.subtitle}>{t('autofixer.subtitle')}</p>
        </div>

        <div className={css.presets}>
          <button
            type="button"
            className={css.presetButton}
            onClick={() => { applyPreset('nightly') }}
          >
            {t('autofixer.presetNightly')}
          </button>
          <button
            type="button"
            className={css.presetButton}
            onClick={() => { applyPreset('continuous') }}
          >
            {t('autofixer.presetContinuous')}
          </button>
          <button
            type="button"
            className={css.presetButton}
            onClick={() => { applyPreset('instant_p0') }}
          >
            {t('autofixer.presetInstantP0')}
          </button>
        </div>
      </header>

      {savedNotice !== null && <div className={css.notice} role="status">{savedNotice}</div>}

      <div className={css.grid}>
        {/* Enable / Disable */}
        <div className={css.fieldGroup}>
          <label className={css.toggleRow}>
            <input
              type="checkbox"
              aria-label={t('autofixer.enabled')}
              checked={config.enabled}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setConfig(c => ({ ...c, enabled: e.target.checked }))
              }}
            />
            <span>{t('autofixer.enabled')}</span>
          </label>
        </div>

        {/* Target Scope */}
        <div className={css.fieldGroup}>
          <label>
            <span>{t('autofixer.targetScope')}</span>
            <select
              aria-label={t('autofixer.targetScope')}
              value={config.targetScope}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                const scope = e.target.value as AutofixerTargetScope
                setConfig(c => ({
                  ...c,
                  targetScope: scope,
                  projectId: scope === 'project' ? (c.projectId ?? targetProjectList[0] ?? '') : undefined,
                }))
              }}
            >
              <option value="workspace">{t('autofixer.scopeWorkspace')}</option>
              <option value="project">{t('autofixer.scopeProject')}</option>
            </select>
          </label>
          {selectedProjectId && (config.targetScope !== 'project' || config.projectId !== selectedProjectId) && (
            <button
              type="button"
              className={css.presetButton}
              onClick={applySelectedProject}
            >
              {t('autofixer.useSelectedProject')}: {selectedProjectId}
            </button>
          )}
        </div>

        {/* Project Selector (when targetScope === project) */}
        {isTargetingProject && (
          <div className={css.fieldGroup}>
            <label>
              <span>{t('autofixer.projectId')}</span>
              {targetProjectList.length > 0 ? (
                <select
                  aria-label={t('autofixer.projectId')}
                  value={config.projectId ?? ''}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    const nextId = e.target.value
                    setConfig(c => ({ ...c, projectId: nextId }))
                    onSelectProject?.(nextId === '' ? null : nextId)
                  }}
                >
                  <option value="">{t('autofixer.projectIdPlaceholder')}</option>
                  {targetProjectList.map(pid => (
                    <option key={pid} value={pid}>{pid}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  aria-label={t('autofixer.projectId')}
                  placeholder={t('autofixer.projectIdPlaceholder')}
                  value={config.projectId ?? ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const nextVal = e.target.value
                    setConfig(c => ({ ...c, projectId: nextVal }))
                  }}
                />
              )}
            </label>
            {selectedProjectId && selectedProjectId !== config.projectId && (
              <button
                type="button"
                className={css.presetButton}
                onClick={applySelectedProject}
              >
                {t('autofixer.useSelectedProject')}: {selectedProjectId}
              </button>
            )}
          </div>
        )}

        {/* Schedule Mode */}
        <div className={css.fieldGroup}>
          <label>
            <span>{t('autofixer.scheduleMode')}</span>
            <select
              aria-label={t('autofixer.scheduleMode')}
              value={config.scheduleMode}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                const mode = e.target.value as AutofixerScheduleMode
                let expr = config.cronExpression
                if (mode === 'nightly') expr = '0 21 * * *'
                else if (mode === 'continuous_cicd') expr = '0 * * * *'
                else if (mode === 'instant_p0') expr = '0 21 * * *'
                setConfig(c => ({ ...c, scheduleMode: mode, cronExpression: expr }))
              }}
            >
              <option value="instant_p0">{t('autofixer.scheduleInstantP0')}</option>
              <option value="nightly">{t('autofixer.scheduleNightly')}</option>
              <option value="continuous_cicd">{t('autofixer.scheduleContinuous')}</option>
              <option value="custom">{t('autofixer.scheduleCustom')}</option>
            </select>
          </label>
        </div>

        {/* Custom Cron Expression */}
        {config.scheduleMode === 'custom' && (
          <div className={css.fieldGroup}>
            <label>
              <span>{t('autofixer.cronExpression')}</span>
              <input
                type="text"
                aria-label={t('autofixer.cronExpression')}
                value={config.cronExpression}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const expr = e.target.value
                  setConfig(c => ({ ...c, cronExpression: expr }))
                }}
              />
            </label>
          </div>
        )}

        {/* Severity P0 Policy */}
        <div className={css.fieldGroup}>
          <label>
            <span>{t('autofixer.p0Action')}</span>
            <select
              aria-label={t('autofixer.p0Action')}
              value={config.p0Action}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                setConfig(c => ({ ...c, p0Action: e.target.value as AutofixerP0Action }))
              }}
            >
              <option value="instant_dispatch">{t('autofixer.p0InstantDispatch')}</option>
              <option value="escalate_only">{t('autofixer.p0EscalateOnly')}</option>
            </select>
          </label>
        </div>

        {/* Severity P1 Policy */}
        <div className={css.fieldGroup}>
          <label>
            <span>{t('autofixer.p1Action')}</span>
            <select
              aria-label={t('autofixer.p1Action')}
              value={config.p1Action}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                setConfig(c => ({ ...c, p1Action: e.target.value as AutofixerP1Action }))
              }}
            >
              <option value="scheduled_cicd">{t('autofixer.p1ScheduledCicd')}</option>
              <option value="plan_only">{t('autofixer.p1PlanOnly')}</option>
            </select>
          </label>
        </div>

        {/* Severity P2 Policy */}
        <div className={css.fieldGroup}>
          <label>
            <span>{t('autofixer.p2Action')}</span>
            <select
              aria-label={t('autofixer.p2Action')}
              value={config.p2Action}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                setConfig(c => ({ ...c, p2Action: e.target.value as AutofixerP2Action }))
              }}
            >
              <option value="plan_only">{t('autofixer.p2PlanOnly')}</option>
              <option value="ignore">{t('autofixer.p2Ignore')}</option>
            </select>
          </label>
        </div>

        {/* Production Downtime Tolerance */}
        <div className={css.fieldGroup}>
          <label>
            <span>{t('autofixer.downtimeTolerance')}</span>
            <select
              aria-label={t('autofixer.downtimeTolerance')}
              value={config.productionDowntimeToleranceMinutes}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                setConfig(c => ({
                  ...c,
                  productionDowntimeToleranceMinutes: Number(e.target.value),
                }))
              }}
            >
              <option value={0}>{t('autofixer.downtime0')}</option>
              <option value={5}>{t('autofixer.downtime5')}</option>
              <option value={15}>{t('autofixer.downtime15')}</option>
              <option value={30}>{t('autofixer.downtime30')}</option>
              <option value={60}>{t('autofixer.downtime60')}</option>
            </select>
          </label>
        </div>

        {/* Action if Downtime Exceeded */}
        <div className={css.fieldGroup}>
          <label>
            <span>{t('autofixer.downtimeExceededAction')}</span>
            <select
              aria-label={t('autofixer.downtimeExceededAction')}
              value={config.downtimeExceededAction}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                setConfig(c => ({
                  ...c,
                  downtimeExceededAction: e.target.value as AutofixerDowntimeAction,
                }))
              }}
            >
              <option value="quarantine_and_escalate">{t('autofixer.actionQuarantineEscalate')}</option>
              <option value="dry_run_only">{t('autofixer.actionDryRunOnly')}</option>
            </select>
          </label>
        </div>

        {/* Worktree Isolation & Max Attempts */}
        <div className={css.fieldGroup}>
          <label className={css.toggleRow}>
            <input
              type="checkbox"
              aria-label={t('autofixer.worktreeIsolation')}
              checked={config.worktreeIsolation}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setConfig(c => ({ ...c, worktreeIsolation: e.target.checked }))
              }}
            />
            <span>{t('autofixer.worktreeIsolation')}</span>
          </label>
          <span className={css.subtitle}>{t('autofixer.worktreeIsolationDesc')}</span>
        </div>

        <div className={css.fieldGroup}>
          <label>
            <span>{t('autofixer.maxAttempts')}</span>
            <input
              type="number"
              aria-label={t('autofixer.maxAttempts')}
              min={1}
              max={5}
              value={config.maxRemediationAttempts}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const val = Math.max(1, Math.min(5, Number(e.target.value) || 2))
                setConfig(c => ({ ...c, maxRemediationAttempts: val }))
              }}
            />
          </label>
        </div>
      </div>

      {/* Verification Gates */}
      <div className={css.fieldGroup}>
        <span className={css.subtitle}><strong>{t('autofixer.verificationGates')}</strong></span>
        <div className={css.gatesGrid}>
          <label className={css.gateOption}>
            <input
              type="checkbox"
              checked={config.verificationGates.doctor}
              onChange={e => { updateGate('doctor', e.target.checked) }}
            />
            <span>{t('autofixer.gateDoctor')}</span>
          </label>
          <label className={css.gateOption}>
            <input
              type="checkbox"
              checked={config.verificationGates.docs}
              onChange={e => { updateGate('docs', e.target.checked) }}
            />
            <span>{t('autofixer.gateDocs')}</span>
          </label>
          <label className={css.gateOption}>
            <input
              type="checkbox"
              checked={config.verificationGates.typecheck}
              onChange={e => { updateGate('typecheck', e.target.checked) }}
            />
            <span>{t('autofixer.gateTypecheck')}</span>
          </label>
          <label className={css.gateOption}>
            <input
              type="checkbox"
              checked={config.verificationGates.build}
              onChange={e => { updateGate('build', e.target.checked) }}
            />
            <span>{t('autofixer.gateBuild')}</span>
          </label>
          <label className={css.gateOption}>
            <input
              type="checkbox"
              checked={config.verificationGates.test}
              onChange={e => { updateGate('test', e.target.checked) }}
            />
            <span>{t('autofixer.gateTest')}</span>
          </label>
          <label className={css.gateOption}>
            <input
              type="checkbox"
              checked={config.verificationGates.smoke}
              onChange={e => { updateGate('smoke', e.target.checked) }}
            />
            <span>{t('autofixer.gateSmoke')}</span>
          </label>
          <label className={css.gateOption}>
            <input
              type="checkbox"
              checked={config.verificationGates.acceptance}
              onChange={e => { updateGate('acceptance', e.target.checked) }}
            />
            <span>{t('autofixer.gateAcceptance')}</span>
          </label>
        </div>
      </div>

      {/* Prompt Helper Panel */}
      <section className={css.promptSection} aria-label={t('autofixer.promptHelper')}>
        <div className={css.tabBar}>
          <button
            type="button"
            className={css.tabButton}
            aria-selected={activeTab === 'prompt'}
            onClick={() => { setActiveTab('prompt') }}
          >
            {t('autofixer.tabPrompt')}
          </button>
          <button
            type="button"
            className={css.tabButton}
            aria-selected={activeTab === 'cron'}
            onClick={() => { setActiveTab('cron') }}
          >
            {t('autofixer.tabCron')}
          </button>
          <button
            type="button"
            className={css.tabButton}
            aria-selected={activeTab === 'systemd'}
            onClick={() => { setActiveTab('systemd') }}
          >
            {t('autofixer.tabSystemd')}
          </button>
          <button
            type="button"
            className={css.tabButton}
            aria-selected={activeTab === 'cicd'}
            onClick={() => { setActiveTab('cicd') }}
          >
            {t('autofixer.tabCicd')}
          </button>

          <button
            type="button"
            className={css.copyButton}
            onClick={() => { void handleCopy() }}
          >
            {copied ? t('autofixer.copied') : t('autofixer.copy')}
          </button>
        </div>

        <pre className={css.codeBox}>
          <code>{currentPreviewText()}</code>
        </pre>
      </section>

      {/* Footer Actions */}
      <div className={css.actionRow}>
        <button
          type="button"
          className={css.saveButton}
          onClick={() => { void handleSave() }}
        >
          {t('autofixer.save')}
        </button>
        {copied && <span className={css.inlineNotice}>{t('autofixer.copied')}</span>}
      </div>
    </section>
  )
}
