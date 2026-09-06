/** GasView visual agents Web dictionaries. */

/** Locale namespace owned by the visual agents Web UI. */
export const NS = 'agent-team-visual'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  trigger: '视觉视图',
  title: '项目视觉代理',
  close: '关闭',
  loading: '正在加载视觉场景…',
  empty: '还没有可显示的项目',
  error: '视觉场景加载失败',
  refresh: '刷新场景',
  'toggle.on': '启用视觉代理',
  'toggle.off': '停用视觉代理',
  'toggle.disabledNotice': '此项目尚未启用视觉代理；打开开关以查看场景。',
  'scene.noProject': '未选择项目',
  'scene.projectPlaque': '项目 {projectId}',
  'scene.agents': '代理',
  'scene.overseer': '监工',
  'dashboard.stale': '所选项目已不在最新概览中，已清除选择。',
} satisfies Record<string, string>

/** Visual agents locale key union. */
export type TeamVisualKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  trigger: 'Visual agents',
  title: 'Project visual agents',
  close: 'Close',
  loading: 'Loading visual scene…',
  empty: 'No projects to display yet',
  error: 'Visual scene failed to load',
  refresh: 'Refresh scene',
  'toggle.on': 'Visual agents on',
  'toggle.off': 'Visual agents off',
  'toggle.disabledNotice': 'Visual agents are off for this project; flip the switch to view the scene.',
  'scene.noProject': 'No project selected',
  'scene.projectPlaque': 'Project {projectId}',
  'scene.agents': 'Agents',
  'scene.overseer': 'Overseer',
  'dashboard.stale': 'The selected project is absent from the latest dashboard and was cleared.',
} satisfies Record<TeamVisualKey, string>
