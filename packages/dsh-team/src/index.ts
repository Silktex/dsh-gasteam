/**
 * The package root is intentionally a no-op Cordis plugin.
 * Runtime services are mounted by the package's DSH bundle patch.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-team'

export function apply(_ctx: Context): void {}
