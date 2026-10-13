/**
 * Version parsing shared by package.json merging and the CLI version check.
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
  const match = trimmed.match(
    /^(?:\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );

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

/** Whether a version carries a prerelease tag (`2.0.0-beta.1`). */
export function isPrerelease(version: string): boolean {
  return /^v?\d+(?:\.\d+){0,2}-/.test(version.trim());
}

/**
 * Order of two version strings; a prerelease sorts below its release. Unparsable input sorts
 * lowest, so it never wins a "highest version" pick.
 */
export function compareVersionStrings(left: string, right: string): number {
  const a = parseComparableVersion(left);
  const b = parseComparableVersion(right);
  if (!a || !b) return Number(!!a) - Number(!!b);
  return compareVersions(a, b) || Number(isPrerelease(right)) - Number(isPrerelease(left));
}

/**
 * Whether `version` falls inside a comparator range as security advisories write them:
 * space-separated comparators (`>=4.0.0 <4.3.2`, `<=3.0.3`), alternatives joined by `||`.
 * A range with no readable comparator matches nothing.
 */
export function satisfiesComparators(version: string, range: string): boolean {
  return range.split('||').some((alternative) => {
    const comparators = [...alternative.matchAll(/(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/g)];
    if (comparators.length === 0) return false;
    return comparators.every(([, operator = '=', bound]) => {
      const order = compareVersionStrings(version, bound);
      if (operator === '>=') return order >= 0;
      if (operator === '<=') return order <= 0;
      if (operator === '>') return order > 0;
      if (operator === '<') return order < 0;
      return order === 0;
    });
  });
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
