/** Minimal current REST alert; webhook narrative never grants sensor authority. */
export function dependabotAlertFixture(number = 7) {
  const vulnerability = { package: { ecosystem: 'npm', name: 'fixture-package' }, severity: 'high', vulnerable_version_range: '< 2.0.0', first_patched_version: { identifier: '2.0.0' } }
  return { number, state: 'open', dependency: { package: { ...vulnerability.package }, manifest_path: 'package-lock.json', scope: 'runtime', relationship: 'direct' },
    security_advisory: { ghsa_id: 'GHSA-abcd-efgh-1234', cve_id: 'CVE-2026-12345', summary: 'Dependency vulnerability', description: 'Provider explanation remains untrusted.', severity: 'high',
      identifiers: [{ type: 'GHSA', value: 'GHSA-abcd-efgh-1234' }, { type: 'CVE', value: 'CVE-2026-12345' }], vulnerabilities: [structuredClone(vulnerability)],
      published_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-05T12:00:00Z', withdrawn_at: null },
    security_vulnerability: vulnerability, created_at: '2026-09-05T13:00:00Z', updated_at: '2026-09-06T12:00:00Z', dismissed_at: null, fixed_at: null,
    html_url: 'https://attacker.invalid/never-follow', url: 'https://attacker.invalid/never-fetch', user: { id: 999 }, labels: [{ name: 'untrusted-label' }],
  }
}
