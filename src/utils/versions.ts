/**
 * Version parsing for package.json merging, the CLI version check and the audit's breaking jumps:
 * plain versions and simple ranges, partial ones (`2.8`) included. Range matching and ordering of
 * published versions go through `semver`.
 */

interface ComparableVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * The version a plain version or simple range names (`1.2.3`, `^1.2`, `>=1.2.3`), or null for
 * anything else.
 */
export function parseComparableVersion(version: string): ComparableVersion | null {
  const trimmed = version.trim();
  const match = trimmed.match(/^(?:\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

/** Standard comparator: negative when `left` is lower, zero when equal, positive when higher. */
export function compareVersions(left: ComparableVersion, right: ComparableVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/**
 * Whether moving `from` to `to` leaves the range a caret allows: another major, or below 1.0
 * another minor (below 0.1 any other version).
 */
export function isBreakingJump(from: string, to: string): boolean {
  const a = parseComparableVersion(from);
  const b = parseComparableVersion(to);
  if (!a || !b) return true;
  if (a.major !== b.major) return true;
  if (a.major > 0) return false;
  if (a.minor !== b.minor) return true;
  return a.minor === 0 && a.patch !== b.patch;
}
