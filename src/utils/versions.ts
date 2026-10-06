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
 * anything else: protocols (`workspace:`, `link:`, `file:`, git and URLs), `*` and `||` unions.
 */
export function parseComparableVersion(version: string): ComparableVersion | null {
  const trimmed = version.trim();

  if (
    trimmed === '' ||
    trimmed === '*' ||
    trimmed.includes('workspace:') ||
    trimmed.includes('catalog:') ||
    trimmed.includes('file:') ||
    trimmed.includes('link:') ||
    trimmed.includes('git+') ||
    trimmed.includes('github:') ||
    trimmed.includes('http://') ||
    trimmed.includes('https://') ||
    trimmed.includes('||')
  ) {
    return null;
  }

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

export function compareVersions(left: ComparableVersion, right: ComparableVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}
