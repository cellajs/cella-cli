/**
 * Audit service for the Cella CLI.
 *
 * Checks for outdated packages and security vulnerabilities across the monorepo.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { checkbox, confirm, Separator } from '@inquirer/prompts';
import type { RuntimeConfig } from '../config/types';
import {
  type AuditResult,
  buildVulnerabilityMap,
  clearCache,
  type EnhancedPackageInfo,
  fetchNpmMetadata,
  findChangelogUrl,
  formatDependents,
  getHighestSeverity,
  getOutdatedPackages,
  getReleasesUrl,
  getRepoUrl,
  getVulnIcon,
  isMajorVersionChange,
  loadCache,
  middleTruncate,
  runPnpmAudit,
  saveCache,
  type VulnerabilityInfo,
} from '../utils/audit-utils';
import pc from '../utils/colors';
import {
  checkMark,
  createSpinner,
  DIVIDER,
  hyperlink,
  spinnerSuccess,
  spinnerText,
  warningMark,
} from '../utils/display';
import { parseYamlBlockMap } from '../utils/yaml';

/** Sentinel value for the audit --fix checkbox */
const AUDIT_FIX_VALUE = '__audit_fix__';

/** A dependent workspace's package.json: its name plus dependency maps, for display names and pin detection. */
type DependentPkgJson = { name?: string } & Partial<Record<'dependencies' | 'devDependencies', Record<string, string>>>;

/** Reader for dependents' package.jsons that loads each one once, caching by location. */
function createDependentPkgReader(): (location: string) => DependentPkgJson | null {
  const cache = new Map<string, DependentPkgJson | null>();
  return (location) => {
    let cached = cache.get(location);
    if (cached === undefined) {
      try {
        cached = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8'));
      } catch {
        cached = null;
      }
      cache.set(location, cached ?? null);
    }
    return cached ?? null;
  };
}

/** Vulnerability counts per severity, as `pnpm audit` reports them in its metadata. */
type SeverityCounts = Partial<AuditResult['metadata']['vulnerabilities']>;

/**
 * Colored `N <severity>` parts for the severities with a non-zero count, in display order.
 * `suffix` rides inside each colored part except `low`, which always ends a summary.
 */
function formatSeverityCounts(counts: SeverityCounts, suffix = ''): string[] {
  const parts: string[] = [];
  if (counts.critical) parts.push(pc.red(`${counts.critical} critical${suffix}`));
  if (counts.high) parts.push(pc.red(`${counts.high} high${suffix}`));
  if (counts.moderate) parts.push(pc.yellow(`${counts.moderate} moderate${suffix}`));
  if (counts.low) parts.push(pc.blue(`${counts.low} low`));
  return parts;
}

export async function runAudit(config: RuntimeConfig): Promise<void> {
  const { forkPath } = config;

  if (config.checkOverrides) {
    await checkOverrides(forkPath);
    return;
  }

  const spinner = createSpinner('checking for outdated packages & vulnerabilities...');
  try {
    // --force drops both caches so registry data is fetched fresh.
    if (config.force) {
      spinnerText('clearing pnpm metadata cache...');
      clearCache();
      spawnSync('pnpm', ['cache', 'delete', '*'], {
        cwd: forkPath,
        stdio: 'ignore',
      });
      spinnerText('checking for outdated packages & vulnerabilities...');
    }

    const [outdatedPackages, auditResult] = await Promise.all([getOutdatedPackages(forkPath), runPnpmAudit(forkPath)]);

    const packageNames = Object.keys(outdatedPackages);
    const vulnMap = buildVulnerabilityMap(auditResult);

    if (packageNames.length === 0 && vulnMap.size === 0) {
      spinnerSuccess('all packages are up to date and secure');
      return;
    }

    // The cache holds resolved changelog URLs.
    const cache = loadCache();

    spinnerText(`found ${packageNames.length} outdated package(s), fetching metadata...`);

    const readDependentPkg = createDependentPkgReader();

    const dependentNameCache = new Map<string, string>();
    for (const name of packageNames) {
      for (const dep of outdatedPackages[name].dependentPackages) {
        if (!dependentNameCache.has(dep.location)) {
          dependentNameCache.set(dep.location, readDependentPkg(dep.location)?.name || basename(dep.location));
        }
      }
    }

    const enhancedPackages: EnhancedPackageInfo[] = [];
    const batchSize = 10;

    for (let i = 0; i < packageNames.length; i += batchSize) {
      const batch = packageNames.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (name) => {
          const pkg = outdatedPackages[name];
          const metadata = await fetchNpmMetadata(name);
          const repoUrl = getRepoUrl(metadata);
          const changelogUrl = await findChangelogUrl(repoUrl, name, cache);

          // Workspaces that pin this package to an exact version.
          const pinnedIn: string[] = [];
          for (const d of pkg.dependentPackages) {
            const spec = readDependentPkg(d.location)?.[pkg.dependencyType]?.[name] || '';
            if (spec && !spec.startsWith('^') && !spec.startsWith('~') && !spec.startsWith('>')) {
              pinnedIn.push(d.name);
            }
          }

          return {
            name,
            current: pkg.current,
            latest: pkg.latest,
            dependents: pkg.dependentPackages.map((d) => d.name),
            dependentLocations: pkg.dependentPackages.map((d) => d.location),
            isDev: pkg.dependencyType === 'devDependencies',
            isMajorUpdate: isMajorVersionChange(pkg.current, pkg.latest),
            pinnedIn,
            repoUrl,
            changelogUrl,
            releasesUrl: getReleasesUrl(repoUrl),
            vulnerabilities: vulnMap.get(name) || [],
          };
        }),
      );
      enhancedPackages.push(...results);
    }

    saveCache(cache);

    enhancedPackages.sort((a, b) => {
      const depA = formatDependents(a.dependents);
      const depB = formatDependents(b.dependents);
      const depCompare = depA.localeCompare(depB);
      if (depCompare !== 0) return depCompare;
      return a.name.localeCompare(b.name);
    });

    spinner.stop();

    if (enhancedPackages.length > 0) {
      printOutdatedResults(enhancedPackages, dependentNameCache, forkPath);
    }
    printVulnerabilityResults(auditResult, vulnMap);

    // --list is the non-interactive mode: report only, no update prompt.
    const hasVulns = vulnMap.size > 0;
    if ((enhancedPackages.length > 0 || hasVulns) && !config.list) {
      await promptForUpdates(enhancedPackages, forkPath, auditResult);
    }
  } finally {
    spinner.stop();
  }
}

function printOutdatedResults(
  enhancedPackages: EnhancedPackageInfo[],
  dependentNameCache: Map<string, string>,
  forkPath: string,
): void {
  const DEV_TAG = ' (dev)';
  const MAX_NAME_LEN = 35;
  const MAX_DEPENDENTS_LEN = 15;
  const maxNameLen = Math.min(
    MAX_NAME_LEN,
    Math.max(7, ...enhancedPackages.map((p) => p.name.length + (p.isDev ? DEV_TAG.length : 0))),
  );
  const maxCurrentLen = Math.max(7, ...enhancedPackages.map((p) => p.current.length));
  const maxLatestLen = Math.max(6, ...enhancedPackages.map((p) => p.latest.length));
  const maxDependentsLen = Math.min(
    MAX_DEPENDENTS_LEN,
    Math.max(10, ...enhancedPackages.map((p) => formatDependents(p.dependents).length)),
  );

  // The vuln column is a single dot, so it gets no width budget.
  const header = [
    ' ',
    pc.bold('package'.padEnd(maxNameLen)),
    pc.bold('current'.padEnd(maxCurrentLen)),
    pc.bold('latest'.padEnd(maxLatestLen)),
    pc.bold('in'.padEnd(maxDependentsLen)),
    pc.bold('links'),
  ].join(' ');

  console.info(header);

  for (const pkg of enhancedPackages) {
    const highestSeverity = getHighestSeverity(pkg.vulnerabilities);
    const vulnIndicator = highestSeverity ? getVulnIcon(highestSeverity) : ' ';

    const fullName = pkg.isDev ? `${pkg.name}${DEV_TAG}` : pkg.name;
    const displayName = middleTruncate(fullName, maxNameLen);
    const name = pc.white(displayName.padEnd(maxNameLen));

    const current = pc.red(pkg.current.padEnd(maxCurrentLen));
    const latestText = pkg.latest.padEnd(maxLatestLen);
    const latest = pkg.isMajorUpdate ? pc.bold(pc.green(latestText)) : pc.green(latestText);

    const dependentsText = formatDependents(pkg.dependents);
    const dependents = pc.dim(middleTruncate(dependentsText, maxDependentsLen).padEnd(maxDependentsLen));

    const links: string[] = [];
    if (pkg.changelogUrl) {
      links.push(hyperlink(pc.magenta('log'), pkg.changelogUrl));
    }
    if (pkg.releasesUrl) {
      links.push(hyperlink(pc.blue('rel'), pkg.releasesUrl));
    }
    if (pkg.repoUrl) {
      links.push(hyperlink(pc.cyan('repo'), pkg.repoUrl));
    }

    const linksStr = links.length > 0 ? links.join(' ') : pc.dim('n/a');

    console.info(`${vulnIndicator} ${name} ${current} ${latest} ${dependents} ${linksStr}`);
  }

  // Package.json links with counts by dependent name.
  console.info();
  const dependentMap = new Map<string, { location: string; count: number }>();
  for (const pkg of enhancedPackages) {
    for (const loc of pkg.dependentLocations) {
      const dependentName = dependentNameCache.get(loc) || basename(loc);
      const existing = dependentMap.get(dependentName);
      if (existing) {
        existing.count++;
      } else {
        dependentMap.set(dependentName, { location: loc, count: 1 });
      }
    }
  }
  const sortedDependents = [...dependentMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxDependentNameLen = Math.max(0, ...sortedDependents.map(([name]) => name.length));
  for (const [dependentName, { location, count }] of sortedDependents) {
    const packageJsonPath = join(location, 'package.json');
    const relativePath = relative(forkPath, packageJsonPath);
    const paddedName = dependentName.padEnd(maxDependentNameLen);
    console.info(
      `  ${pc.dim('•')} ${paddedName}  ${hyperlink(relativePath, `file://${packageJsonPath}`)} ${pc.dim(`${count}`)}`,
    );
  }
}

/**
 * Build the grouped checkbox choices for the update prompt: the audit --fix entry when
 * vulnerabilities exist, then pinned packages, then the regular ones, with separators.
 */
function buildUpdateChoices(
  packages: EnhancedPackageInfo[],
  auditResult: AuditResult | null,
  hasVulnerabilities: boolean,
): Array<{ name: string; value: string; checked: boolean } | Separator> {
  const makeChoice = (pkg: EnhancedPackageInfo) => {
    const devTag = pkg.isDev ? pc.dim(' (dev)') : '';
    const version = `${pc.red(pkg.current)} → ${pc.green(pkg.latest)}`;
    const pinnedWarning =
      pkg.pinnedIn.length > 0 ? `  ${warningMark} ${pc.dim(`pinned in ${pkg.pinnedIn.join(', ')}`)}` : '';
    return {
      name: `${pkg.name}${devTag}  ${version}${pinnedWarning}`,
      value: pkg.name,
      checked: false,
    };
  };

  const pinned = packages.filter((p) => p.pinnedIn.length > 0);
  const regular = packages.filter((p) => p.pinnedIn.length === 0);

  const choices: Array<{ name: string; value: string; checked: boolean } | Separator> = [];

  if (hasVulnerabilities) {
    const parts = formatSeverityCounts(auditResult?.metadata?.vulnerabilities || {});
    const vulnSummary = parts.length > 0 ? ` ${pc.dim('·')} ${parts.join(' ')}` : '';
    choices.push(new Separator(pc.red(`── vulnerabilities${vulnSummary} ──`)));
    choices.push({
      name: `${pc.cyan('pnpm audit --fix override')}  ${pc.dim('add overrides for non-vulnerable versions')}`,
      value: AUDIT_FIX_VALUE,
      checked: false,
    });
  }

  if (pinned.length > 0) {
    choices.push(new Separator(pc.yellow(`── pinned (${pinned.length}) ──`)));
    choices.push(...pinned.map(makeChoice));
  }
  if (regular.length > 0) {
    if (pinned.length > 0 || hasVulnerabilities) {
      choices.push(new Separator(pc.dim(`── packages (${regular.length}) ──`)));
    }
    choices.push(...regular.map(makeChoice));
  }

  return choices;
}

/** Package-selection prompt; the chosen updates run through {@link executeUpdates}. */
async function promptForUpdates(
  packages: EnhancedPackageInfo[],
  forkPath: string,
  auditResult: AuditResult | null,
): Promise<void> {
  const hasVulnerabilities =
    auditResult !== null && Object.values(auditResult.metadata?.vulnerabilities || {}).some((c) => c > 0);
  const hasPackages = packages.length > 0;

  let confirmMessage = 'update packages?';
  if (hasVulnerabilities && hasPackages) {
    confirmMessage = 'update packages and fix vulnerabilities?';
  } else if (hasVulnerabilities) {
    confirmMessage = 'fix vulnerabilities?';
  }

  let wantsUpdate: boolean;
  try {
    wantsUpdate = await confirm({
      message: confirmMessage,
      default: true,
    });
  } catch {
    return;
  }
  if (!wantsUpdate) return;

  console.info();

  const choices = buildUpdateChoices(packages, auditResult, hasVulnerabilities);

  let selected: string[];
  try {
    selected = await checkbox({
      message: 'toggle packages to update',
      choices,
      required: true,
      pageSize: 20,
      loop: false,
      theme: {
        icon: {
          cursor: '❯ ',
        },
        style: {
          highlight: (text: string) => text,
          keysHelpTip: (keys: [string, string][]) => {
            const tips = keys.map(([key, action]: [string, string]) => `${pc.dim(key)} ${action}`);
            return tips.join('  ');
          },
          renderSelectedChoices: (selectedChoices: Array<{ value?: string }>) =>
            pc.dim(`${selectedChoices.length} package${selectedChoices.length !== 1 ? 's' : ''} selected`),
        },
      },
    });
  } catch {
    // User pressed Ctrl+C or escaped
    return;
  }

  const runAuditFix = selected.includes(AUDIT_FIX_VALUE);
  const selectedPackages = selected.filter((s) => s !== AUDIT_FIX_VALUE);

  await executeUpdates(packages, forkPath, selectedPackages, runAuditFix);
}

/**
 * The selected updates: major bumps confirmed first, `pnpm audit --fix override` when chosen,
 * then one recursive `pnpm up` (catalog consumers normalized first).
 */
async function executeUpdates(
  packages: EnhancedPackageInfo[],
  forkPath: string,
  selectedPackages: string[],
  runAuditFix: boolean,
): Promise<void> {
  const summaryParts: string[] = [];
  if (selectedPackages.length > 0) {
    summaryParts.push(`updating ${selectedPackages.length} package${selectedPackages.length !== 1 ? 's' : ''}`);
  }
  if (runAuditFix) {
    summaryParts.push('then updating dependencies');
  }
  console.info();
  console.info(pc.green(`✓ ${summaryParts.join(' ')}`));
  console.info();

  const selectedMajor = packages.filter((p) => selectedPackages.includes(p.name) && p.isMajorUpdate);
  if (selectedMajor.length > 0) {
    const majorNames = selectedMajor.map((p) => pc.bold(p.name)).join(', ');
    try {
      const proceed = await confirm({
        message: `${selectedMajor.length} major update${selectedMajor.length > 1 ? 's' : ''} selected (${majorNames}). proceed?`,
        default: true,
      });
      if (!proceed) {
        console.info(pc.dim('  update cancelled'));
        return;
      }
    } catch {
      return;
    }
  }

  const catalogPackages = readCatalogPackageNames(forkPath);

  const workspacePackages = new Map<string, string[]>();
  for (const pkgName of selectedPackages) {
    const pkg = packages.find((p) => p.name === pkgName);
    if (!pkg) continue;

    for (const dependent of pkg.dependents) {
      const group = workspacePackages.get(dependent);
      if (group) group.push(pkgName);
      else workspacePackages.set(dependent, [pkgName]);
    }
  }

  // Audit --fix runs before the package updates so its overrides apply during install.
  if (runAuditFix) {
    console.info(pc.dim('running pnpm audit --fix override...'));
    const auditFixResult = spawnSync('pnpm', ['audit', '--fix', 'override'], {
      cwd: forkPath,
      stdio: 'inherit',
    });

    console.info();
    if (auditFixResult.status === 0) {
      console.info(pc.green('✓ pnpm audit --fix override completed'));
    } else {
      console.error(pc.red(`✗ pnpm audit --fix override failed (exit code ${auditFixResult.status})`));
    }
  }

  // Summarize impacted workspaces before running a single workspace-wide update.
  // Catalog consumers are normalized before the recursive update so a strict
  // catalogMode cannot fail it with ERR_PNPM_CATALOG_VERSION_MISMATCH.
  for (const [workspace, pkgs] of workspacePackages) {
    const pkgList = pkgs.join(', ');
    console.info(`${pc.cyan('↑')} ${pc.bold(workspace)}: ${pc.dim(pkgList)}`);
  }

  if (selectedPackages.length > 0) {
    console.info();

    const selectedCatalogPackages = selectedPackages.filter((pkgName) => catalogPackages.has(pkgName));

    if (selectedCatalogPackages.length > 0) {
      console.info(pc.dim(`normalizing catalog consumers: ${selectedCatalogPackages.join(', ')}`));
      const normalizeResult = spawnSync('pnpm', ['-r', 'up', ...selectedCatalogPackages], {
        cwd: forkPath,
        stdio: 'inherit',
      });

      console.info();
      if (normalizeResult.status !== 0) {
        console.error(pc.red(`✗ catalog normalization failed (exit code ${normalizeResult.status})`));
        return;
      }
    }

    // Run one recursive update so pnpm can rewrite catalogs and direct consumers atomically.
    const result = spawnSync('pnpm', ['-r', 'up', '--latest', ...selectedPackages], {
      cwd: forkPath,
      stdio: 'inherit',
    });

    console.info();
    if (result.status === 0) {
      console.info(pc.green(`✓ ${selectedPackages.length} package${selectedPackages.length > 1 ? 's' : ''} updated`));
    } else {
      console.error(pc.red(`✗ update failed (exit code ${result.status})`));
    }
  }
}

function printVulnerabilityResults(auditResult: AuditResult | null, vulnMap: Map<string, VulnerabilityInfo[]>): void {
  if (auditResult && vulnMap.size > 0) {
    const vulnMeta = auditResult.metadata?.vulnerabilities || {};

    console.info();
    console.info(
      `${pc.red('⚠')} ${pc.bold('vulnerabilities')} ${pc.dim('·')} ${formatSeverityCounts(vulnMeta, ' ').join('')}`,
    );
    console.info(DIVIDER);

    for (const [pkgName, vulns] of vulnMap.entries()) {
      for (const vuln of vulns) {
        const severityIcon = getVulnIcon(vuln.severity);
        const cveStr = vuln.cves.length > 0 ? pc.dim(` ${vuln.cves[0]}`) : '';
        // Source info renders as "in <workspace> via <direct-dep>" or just "in <workspace>".
        let sourceStr = '';
        if (vuln.workspace) {
          sourceStr = pc.dim(` in ${vuln.workspace}`);
          if (vuln.directDependency) {
            sourceStr += pc.dim(` via ${vuln.directDependency}`);
          }
        }
        const title = middleTruncate(vuln.title, 60);
        console.info(
          `${severityIcon} ${pc.white(pkgName)} ${pc.dim(vuln.vulnerableVersions)}${sourceStr} ${pc.dim('·')} ${title}${cveStr}`,
        );
      }
    }
  } else {
    console.info();
    console.info(`${checkMark} no vulnerabilities found`);
  }

  console.info();
}

function readCatalogPackageNames(forkPath: string): Set<string> {
  const workspacePath = join(forkPath, 'pnpm-workspace.yaml');
  try {
    const content = readFileSync(workspacePath, 'utf8');
    return new Set(Object.keys(parseYamlBlockMap(content, 'catalog')));
  } catch {
    return new Set();
  }
}

/** All pnpm.overrides from package.json and pnpm-workspace.yaml, keyed by override key with target version and source file. */
function readOverrides(forkPath: string): Map<string, { target: string; source: string }> {
  const overrides = new Map<string, { target: string; source: string }>();

  const pkgJsonPath = join(forkPath, 'package.json');
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const pnpmOverrides = pkgJson.pnpm?.overrides || {};
    for (const [key, value] of Object.entries(pnpmOverrides)) {
      overrides.set(key, { target: value as string, source: 'package.json' });
    }
  } catch {
    // skip
  }

  const workspacePath = join(forkPath, 'pnpm-workspace.yaml');
  try {
    const content = readFileSync(workspacePath, 'utf8');
    const wsOverrides = parseYamlBlockMap(content, 'overrides');
    for (const [key, value] of Object.entries(wsOverrides)) {
      overrides.set(key, { target: value, source: 'pnpm-workspace.yaml' });
    }
  } catch {
    // skip
  }

  return overrides;
}

/** The --check-overrides report: each pnpm.override cross-referenced with the current audit. */
async function checkOverrides(forkPath: string): Promise<void> {
  const spinner = createSpinner('checking overrides against current audit...');

  const overrides = readOverrides(forkPath);

  if (overrides.size === 0) {
    spinnerSuccess('no pnpm.overrides found');
    return;
  }

  const auditResult = await runPnpmAudit(forkPath);

  const activeAdvisoryPackages = new Set<string>();
  if (auditResult?.advisories) {
    for (const advisory of Object.values(auditResult.advisories)) {
      activeAdvisoryPackages.add(advisory.module_name);
    }
  }

  spinner.stop();

  const securityOverrides: Array<{ key: string; pkg: string; target: string; source: string; status: string }> = [];
  const pinOverrides: Array<{ key: string; target: string; source: string }> = [];

  for (const [key, { target, source }] of overrides) {
    // Security overrides have version selectors like "pkg@<=1.0.0" or "pkg@>=1.0.0 <2.0.0"
    const atIndex = key.indexOf('@', key.startsWith('@') ? 1 : 0);
    if (atIndex > 0) {
      const pkg = key.slice(0, atIndex);
      const hasActiveAdvisory = activeAdvisoryPackages.has(pkg);
      const status = hasActiveAdvisory ? 'active' : 'likely stale';
      securityOverrides.push({ key, pkg, target, source, status });
    } else {
      pinOverrides.push({ key, target, source });
    }
  }

  const allKeys = Array.from(overrides.keys());
  const allValues = Array.from(overrides.values());
  const maxKeyLen = Math.max(8, ...allKeys.map((k) => k.length));
  const maxTargetLen = Math.max(6, ...allValues.map((v) => v.target.length));

  if (securityOverrides.length > 0) {
    console.info(pc.bold(`security overrides (${securityOverrides.length})`));
    console.info(DIVIDER);

    for (const o of securityOverrides) {
      const icon = o.status === 'active' ? pc.red('●') : pc.green('○');
      const statusText = o.status === 'active' ? pc.red('active') : pc.green('likely stale');
      const keyText = pc.white(o.key.padEnd(maxKeyLen));
      const targetText = pc.dim(o.target.padEnd(maxTargetLen));
      const sourceText = pc.dim(o.source);
      console.info(`  ${icon} ${keyText} → ${targetText} ${statusText}  ${sourceText}`);
    }
    console.info();
  }

  if (pinOverrides.length > 0) {
    console.info(pc.bold(`version pins (${pinOverrides.length})`));
    console.info(DIVIDER);

    for (const o of pinOverrides) {
      const keyText = pc.white(o.key.padEnd(maxKeyLen));
      const targetText = pc.dim(o.target.padEnd(maxTargetLen));
      const sourceText = pc.dim(o.source);
      console.info(`  ${pc.blue('◆')} ${keyText} → ${targetText}  ${sourceText}`);
    }
    console.info();
  }

  const staleCount = securityOverrides.filter((o) => o.status === 'likely stale').length;
  const activeCount = securityOverrides.filter((o) => o.status === 'active').length;

  if (staleCount > 0) {
    console.info(
      `${pc.green('○')} ${staleCount} override${staleCount !== 1 ? 's' : ''} likely stale: no matching advisory found in current audit`,
    );
    console.info(pc.dim('  overrides mask vulnerabilities: verify by temporarily removing and running pnpm audit'));
  }
  if (activeCount > 0) {
    console.info(
      `${pc.red('●')} ${activeCount} override${activeCount !== 1 ? 's' : ''} still active: advisory present without override`,
    );
  }
  if (pinOverrides.length > 0) {
    console.info(
      `${pc.blue('◆')} ${pinOverrides.length} version pin${pinOverrides.length !== 1 ? 's' : ''}: not security-related, review manually`,
    );
  }
  console.info();
}
