/**
 * The package root is intentionally a no-op Cordis plugin.
 * Runtime services are mounted by the package's DSH bundle patch.
 */
export const name = 'dsh-team'

export function apply(): void {}
