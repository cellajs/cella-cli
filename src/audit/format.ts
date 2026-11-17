/**
 * How the audit draws its rows: severity dots, names cut to a column, and dependents.
 */

import pc from '../utils/colors';
import { checkMark, plural, warningMark } from '../utils/display';
import type { VulnerabilitySeverity } from '../utils/pnpm';

const dots: Record<VulnerabilitySeverity, string> = {
  critical: pc.red('●'),
  high: pc.red('●'),
  moderate: pc.yellow('●'),
  low: pc.blue('●'),
  info: pc.gray('●'),
};

/** The colored dot of a severity; a blank for none. */
export const severityDot = (severity: VulnerabilitySeverity | null): string => (severity ? dots[severity] : ' ');

/** Middle-truncation to maxLen, e.g. "very-long-package-name" -> "very-lo…e-name". */
export function middleTruncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const shown = maxLen - 1;
  return `${str.slice(0, Math.ceil(shown / 2))}…${str.slice(-Math.floor(shown / 2))}`;
}

/** Dependents as "first +N" when multiple. */
export function formatDependents(dependents: string[]): string {
  if (dependents.length <= 1) return dependents[0] ?? '';
  return `${dependents[0]} +${dependents.length - 1}`;
}

/**
 * The verdict on the workspace as installed, with its overrides and ignores in place: whether pnpm
 * audit reports any package there, followed by a dim note.
 */
export function installedVerdict(vulnerable: number, note: string): string {
  const verdict =
    vulnerable === 0
      ? `${checkMark} installed: no open vulnerabilities`
      : `${warningMark} installed: ${plural(vulnerable, 'vulnerable package')}`;
  return note ? `${verdict} ${pc.dim(`· ${note}`)}` : verdict;
}

/** A titled block of packages with advisories: severity dot, name, severity, versions and a dim note. */
export function printAdvisoryRows(
  title: string,
  rows: Array<{ module: string; severity: VulnerabilitySeverity; versions: string; note: string }>,
): void {
  if (rows.length === 0) return;
  const nameWidth = Math.min(30, Math.max(...rows.map((row) => row.module.length)));
  const versionWidth = Math.max(...rows.map((row) => row.versions.length));
  console.info(title);
  for (const row of rows) {
    const name = pc.white(middleTruncate(row.module, nameWidth).padEnd(nameWidth));
    console.info(
      `${severityDot(row.severity)} ${name}  ${row.severity.padEnd(8)}  ${row.versions.padEnd(versionWidth)}  ${pc.dim(row.note)}`,
    );
  }
  console.info();
}
