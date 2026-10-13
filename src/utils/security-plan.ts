/**
 * The plan behind the audit's security pass: which advisories an override can fix, which have a
 * fix that is too young to install, and which have none. Pure, so the service around it only
 * gathers the inputs and carries the plan out.
 */

import type { AuditResult, VulnerabilitySeverity } from './audit-utils';
import { compareVersionStrings, isBreakingJump, isPrerelease, satisfiesComparators } from './versions';
import type { AuditSettings } from './workspace-yaml';

/** One advisory from `pnpm audit --json`, reduced to what the plan needs. */
export interface Advisory {
  ghsa: string;
  module: string;
  severity: VulnerabilitySeverity;
  /** Vulnerable versions as a comparator range, e.g. `>=4.0.0 <4.3.2`. */
  range: string;
  /** The vulnerable versions the lockfile holds. */
  installed: string[];
  /** The workspace dependencies that pull the package in. */
  via: string[];
  /** A workspace depends on the package directly, so its own manifest decides the version. */
  direct: boolean;
}

/** What can be done about an item. */
export type Remedy =
  /** A published, installable version outside every vulnerable range. */
  | { kind: 'override'; target: string; breaking: boolean }
  /** The fix exists but is younger than the release age. */
  | { kind: 'fresh'; target: string; breaking: boolean; hoursOld: number }
  /** Nothing published fixes it. */
  | { kind: 'none' };

/** How an item relates to the settings from before this run. */
export type Standing =
  /** An override of the same line was in place: applied again without asking. */
  | 'carried'
  /** Its advisories were ignored and stay so. */
  | 'ignored'
  /** Not seen before: applied when safe, asked about otherwise. */
  | 'new';

/** The advisories on one package that share a remedy. */
export interface SecurityItem {
  module: string;
  severity: VulnerabilitySeverity;
  ghsas: string[];
  /** The lowest vulnerable version installed. */
  installed: string;
  via: string[];
  direct: boolean;
  remedy: Remedy;
  standing: Standing;
  /** The override entries that apply the remedy; empty when there is none. */
  overrides: Record<string, string>;
}

/** Publish time per version of one package, as the registry's `time` field gives it. */
export type PublishTimes = Record<string, string>;

export interface PlanInput {
  advisories: Advisory[];
  /** Publish times per package name; a package the registry did not answer for is absent. */
  published: Record<string, PublishTimes>;
  /** The settings from before the run. */
  previous: AuditSettings;
  /** `minimumReleaseAge` in minutes. */
  releaseAgeMinutes: number;
  now: number;
}

/** Severity levels, most severe first. */
export const SEVERITIES: VulnerabilitySeverity[] = ['critical', 'high', 'moderate', 'low', 'info'];

/**
 * Whether an override key is audit output. A key with a version selector and no parent
 * (`pkg@<1.2.3`) is what an audit fix writes: the audit owns it and rebuilds it every run. A key
 * without a selector (`pkg`) or scoped to a parent (`parent>pkg`) is a decision someone made.
 */
export function isAuditOverride(key: string): boolean {
  // pnpm reads `>` as the parent delimiter unless a space, `|` or `@` comes before it.
  if (/[^ |@]>/.test(key)) return false;
  return key.indexOf('@', 1) > 0;
}

/** The package an override key targets. */
export function overrideModule(key: string): string {
  const child = key.split(/(?<=[^ |@])>/).at(-1) ?? key;
  const at = child.indexOf('@', 1);
  return at > 0 ? child.slice(0, at) : child;
}

/** A `name@version` release-age exclude split in two, or null for a name-only entry or a pattern. */
export function parseVersionedExclude(entry: string): { name: string; version: string } | null {
  const at = entry.lastIndexOf('@');
  if (at <= 0) return null;
  const version = entry.slice(at + 1);
  return /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(version) ? { name: entry.slice(0, at), version } : null;
}

/** The advisories in an audit result. Paths look like `workspace>direct-dep>…>package`. */
export function advisoriesFromAudit(audit: AuditResult): Advisory[] {
  return Object.values(audit.advisories).map((advisory) => {
    const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []).map((path) => path.split('>'));
    return {
      ghsa: advisory.github_advisory_id ?? advisory.url ?? String(advisory.id),
      module: advisory.module_name,
      severity: advisory.severity,
      range: advisory.vulnerable_versions,
      installed: [...new Set((advisory.findings ?? []).map((finding) => finding.version))],
      via: [...new Set(paths.map((parts) => parts[parts.length > 2 ? 1 : 0]))],
      direct: paths.some((parts) => parts.length === 2),
    };
  });
}

/** Milliseconds since `name@version` was published; NaN when the registry lists no time for it. */
const publishedAgo = (name: string, version: string, input: Pick<PlanInput, 'published' | 'now'>): number =>
  input.now - Date.parse(input.published[name]?.[version] ?? '');

/** Whether the release age lets `name@version` install: it is old enough, or an exclude names it. */
function isInstallable(name: string, version: string, input: PlanInput): boolean {
  const excludes = input.previous.releaseAgeExcludes;
  if (excludes.includes(name) || excludes.includes(`${name}@${version}`)) return true;
  const age = publishedAgo(name, version, input);
  return Number.isNaN(age) || age >= input.releaseAgeMinutes * 60_000;
}

/** Whether an override target such as `^7.0.2` or `>=0.28.1` lets `version` in. */
function admits(target: string, version: string): boolean {
  const base = target.replace(/^[\^~>=<\s]+/, '');
  if (compareVersionStrings(base, version) > 0) return false;
  return target.trim().startsWith('>') || !isBreakingJump(base, version);
}

/** The audit overrides a package had before the run. */
const previousOverrides = (module: string, previous: AuditSettings): Array<[key: string, target: string]> =>
  Object.entries(previous.overrides).filter(([key]) => isAuditOverride(key) && overrideModule(key) === module);

/**
 * The audit overrides a package had before the run whose target a published version still meets.
 * An item that is left open keeps them: leaving it open must not undo a fix that was in place.
 */
export function standingOverrides(
  module: string,
  input: Pick<PlanInput, 'previous' | 'published'>,
): Record<string, string> {
  const versions = Object.keys(input.published[module] ?? {});
  return Object.fromEntries(
    previousOverrides(module, input.previous).filter(([, target]) => versions.some((v) => admits(target, v))),
  );
}

/**
 * One item per package and remedy. What the advisory database claims as patched is not trusted,
 * because pnpm guesses it: the fix for an advisory is the lowest published release above what is
 * installed that leaves its range. A release outside every range of the package comes first, and
 * one the release age lets install comes before one it holds back.
 */
export function planSecurity(input: PlanInput): SecurityItem[] {
  const ignored = new Set(input.previous.ignoredGhsas);
  const byModule = Map.groupBy(input.advisories, (advisory) => advisory.module);
  const items: SecurityItem[] = [];

  for (const [module, advisories] of byModule) {
    const versions = Object.keys(input.published[module] ?? {}).filter((v) => /^\d/.test(v));
    const stable = versions.filter((v) => !isPrerelease(v)).sort(compareVersionStrings);
    const escapesAll = (v: string) => !advisories.some((advisory) => satisfiesComparators(v, advisory.range));

    const fixOf = (advisory: Advisory): string | undefined => {
      const highest = [...advisory.installed].sort(compareVersionStrings).at(-1) ?? '0.0.0';
      const candidates = stable.filter(
        (v) => compareVersionStrings(v, highest) > 0 && !satisfiesComparators(v, advisory.range),
      );
      const installable = candidates.filter((v) => isInstallable(module, v, input));
      const pick = (among: string[]) => among.find(escapesAll) ?? among[0];
      return pick(installable) ?? pick(candidates);
    };

    for (const [fix, group] of Map.groupBy(advisories, fixOf)) {
      const installed = [...new Set(group.flatMap((advisory) => advisory.installed))].sort(compareVersionStrings);
      const ghsas = group.map((advisory) => advisory.ghsa);
      const allIgnored = ghsas.every((ghsa) => ignored.has(ghsa));
      const breaking = !!fix && installed.some((v) => isBreakingJump(v, fix));

      let remedy: Remedy = { kind: 'none' };
      let standing: Standing = allIgnored ? 'ignored' : 'new';
      let overrides: Record<string, string> = {};

      if (fix) {
        const hoursOld = Math.max(0, Math.floor(publishedAgo(module, fix, input) / 3_600_000));
        remedy = isInstallable(module, fix, input)
          ? { kind: 'override', target: fix, breaking }
          : { kind: 'fresh', target: fix, breaking, hoursOld };

        overrides = Object.fromEntries(
          [...new Set(group.map((advisory) => advisory.range))].map((range) => {
            const key = `${module}@${range}`;
            const kept = input.previous.overrides[key];
            // A target someone widened by hand (`>=1.2.3`) stays as written while it still admits the fix.
            return [key, kept && admits(kept, fix) ? kept : `^${fix}`];
          }),
        );

        if (remedy.kind === 'override') {
          if (previousOverrides(module, input.previous).some(([, target]) => admits(target, fix))) standing = 'carried';
          // An ignored advisory whose fix arrived moves to an override, unless that takes a breaking jump.
          else if (allIgnored && !breaking) standing = 'new';
        }
      }

      items.push({
        module,
        severity: SEVERITIES.find((severity) => group.some((advisory) => advisory.severity === severity)) ?? 'info',
        ghsas,
        installed: installed[0] ?? '',
        via: [...new Set(group.flatMap((advisory) => advisory.via))],
        direct: group.some((advisory) => advisory.direct),
        remedy,
        standing,
        overrides,
      });
    }
  }

  return items.sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.module.localeCompare(b.module),
  );
}

/**
 * The release-age excludes worth keeping: name-only entries, and versioned ones whose version is
 * still younger than the release age. An aged version installs without its exclude, and one the
 * registry does not list points at nothing.
 */
export function liveExcludes(input: Omit<PlanInput, 'advisories'>): string[] {
  return input.previous.releaseAgeExcludes.filter((entry) => {
    const versioned = parseVersionedExclude(entry);
    // Kept as well when the registry gave no answer for the package: silence is not proof of age.
    if (!versioned || !input.published[versioned.name]) return true;
    return publishedAgo(versioned.name, versioned.version, input) < input.releaseAgeMinutes * 60_000;
  });
}
