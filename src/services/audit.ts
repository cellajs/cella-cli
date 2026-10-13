/**
 * Audit service for the Cella CLI.
 *
 * Two layers, in this order: update the outdated packages a developer picks, then run the security
 * pass on what is left (see audit-security.ts).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { checkbox, confirm, Separator } from '@inquirer/prompts';
import type { RuntimeConfig } from '../config/types';
import {
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
} from '../utils/audit-utils';
import pc from '../utils/colors';
import { createSpinner, hyperlink, spinnerSuccess, spinnerText, warningMark } from '../utils/display';
import { parseYamlBlockMap } from '../utils/yaml';
import { runSecurityPass } from './audit-security';

/** How the update layer ended: the security pass follows unless it failed or was cancelled. */
type UpdateOutcome = 'updated' | 'skipped' | 'cancelled' | 'failed';

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

export async function runAudit(config: RuntimeConfig): Promise<void> {
  const { forkPath } = config;

  const spinner = createSpinner('checking for outdated packages...');
  try {
    // --force drops both caches so registry data is fetched fresh.
    if (config.force) {
      spinnerText('clearing pnpm metadata cache...');
      clearCache();
      spawnSync('pnpm', ['cache', 'delete', '*'], {
        cwd: forkPath,
        stdio: 'ignore',
      });
      spinnerText('checking for outdated packages...');
    }

    const [outdatedPackages, auditResult] = await Promise.all([getOutdatedPackages(forkPath), runPnpmAudit(forkPath)]);

    const packageNames = Object.keys(outdatedPackages);
    const vulnMap = buildVulnerabilityMap(auditResult);

    if (packageNames.length === 0) {
      spinnerSuccess('all packages are up to date');
      console.info();
      await runSecurityPass(forkPath, { apply: !config.list });
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

    printOutdatedResults(enhancedPackages, dependentNameCache, forkPath);
    console.info();

    // --list is the non-interactive mode: report only, no prompts and no writes.
    const outcome = config.list ? 'skipped' : await promptForUpdates(enhancedPackages, forkPath);
    if (outcome === 'cancelled') return;
    if (outcome === 'failed') {
      console.info(`${warningMark} security pass skipped: it needs a workspace that installs`);
      return;
    }
    await runSecurityPass(forkPath, { apply: !config.list });
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

/** The grouped checkbox choices for the update prompt: pinned packages, then the regular ones. */
function buildUpdateChoices(
  packages: EnhancedPackageInfo[],
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

  if (pinned.length > 0) {
    choices.push(new Separator(pc.yellow(`── pinned (${pinned.length}) ──`)));
    choices.push(...pinned.map(makeChoice));
  }
  if (regular.length > 0) {
    if (pinned.length > 0) choices.push(new Separator(pc.dim(`── packages (${regular.length}) ──`)));
    choices.push(...regular.map(makeChoice));
  }

  return choices;
}

/** Package-selection prompt; the chosen updates run through {@link executeUpdates}. */
async function promptForUpdates(packages: EnhancedPackageInfo[], forkPath: string): Promise<UpdateOutcome> {
  let wantsUpdate: boolean;
  try {
    wantsUpdate = await confirm({ message: 'update packages?', default: true });
  } catch {
    return 'cancelled';
  }
  console.info();
  if (!wantsUpdate) return 'skipped';

  const choices = buildUpdateChoices(packages);

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
    return 'cancelled';
  }

  return executeUpdates(packages, forkPath, selected);
}

/** The selected updates: major bumps confirmed first, then one recursive `pnpm up` (catalog consumers normalized first). */
async function executeUpdates(
  packages: EnhancedPackageInfo[],
  forkPath: string,
  selectedPackages: string[],
): Promise<UpdateOutcome> {
  console.info();
  console.info(pc.green(`✓ updating ${selectedPackages.length} package${selectedPackages.length !== 1 ? 's' : ''}`));
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
        console.info();
        return 'skipped';
      }
    } catch {
      return 'cancelled';
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

  // Summarize impacted workspaces before running a single workspace-wide update.
  // Catalog consumers are normalized before the recursive update so a strict
  // catalogMode cannot fail it with ERR_PNPM_CATALOG_VERSION_MISMATCH.
  for (const [workspace, pkgs] of workspacePackages) {
    const pkgList = pkgs.join(', ');
    console.info(`${pc.cyan('↑')} ${pc.bold(workspace)}: ${pc.dim(pkgList)}`);
  }

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
      return 'failed';
    }
  }

  // Run one recursive update so pnpm can rewrite catalogs and direct consumers atomically.
  const result = spawnSync('pnpm', ['-r', 'up', '--latest', ...selectedPackages], {
    cwd: forkPath,
    stdio: 'inherit',
  });

  console.info();
  if (result.status !== 0) {
    console.error(pc.red(`✗ update failed (exit code ${result.status})`));
    return 'failed';
  }
  console.info(pc.green(`✓ ${selectedPackages.length} package${selectedPackages.length > 1 ? 's' : ''} updated`));
  console.info();
  return 'updated';
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
