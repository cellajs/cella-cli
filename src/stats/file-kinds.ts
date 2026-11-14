import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isGeneratedFile } from '../utils/repo-files';
import { readTopLevel } from '../utils/workspace-yaml';

/** Extensions Biome can check (source code, config, styles) */
export const sourceExtensions = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'css', 'html']);

/** Kind of a file. `source` is code, config and styles that are none of the other kinds; `other` is no source at all. */
export type FileKind = 'source' | 'test' | 'stories' | 'generated' | 'json' | 'docs' | 'other';

const docExtensions = new Set(['md', 'mdx']);

/** Lock files are written by the package manager, whatever their extension */
const lockFiles = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']);

/** The kind of a file by its path; a lock file is generated, whatever its extension. */
export function classifyFile(filePath: string): FileKind {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  if (lockFiles.has(name)) return 'generated';
  if (
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.includes('/tests/') ||
    filePath.includes('/test/') ||
    filePath.startsWith('tests/') ||
    filePath.includes('/__tests__/')
  ) {
    return 'test';
  }
  if (filePath.includes('.stories.')) return 'stories';
  if (
    isGeneratedFile(filePath) ||
    filePath.startsWith('drizzle/') ||
    filePath.includes('/drizzle/') ||
    filePath.endsWith('.d.ts') ||
    filePath.includes('.tsbuildinfo')
  ) {
    return 'generated';
  }
  if (filePath.endsWith('.json') || filePath.endsWith('.jsonc')) return 'json';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (docExtensions.has(ext)) return 'docs';
  return sourceExtensions.has(ext) ? 'source' : 'other';
}

/** Workspace package definition from pnpm-workspace.yaml */
interface WorkspacePackage {
  /** Display name (e.g., 'backend', 'cli/cella') */
  name: string;
  /** Path prefix to match (e.g., 'backend/', 'cli/cella/') */
  prefix: string;
}

/** Workspace package names and path prefixes from pnpm-workspace.yaml; none without that file. */
export async function getWorkspacePackages(repoRoot: string): Promise<WorkspacePackage[]> {
  const content = await readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8').catch(() => '');
  const patterns = readTopLevel(content, 'packages');

  return (Array.isArray(patterns) ? patterns.map(String) : []).map((pattern) => {
    // Wildcard patterns like 'cli/*' are resolved per file when matching.
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      return { name: `${base}/*`, prefix: `${base}/` };
    }
    return { name: pattern, prefix: `${pattern}/` };
  });
}

/** The workspace package owning a file, with wildcard patterns resolved per file. */
export function matchPackage(filePath: string, packages: WorkspacePackage[]): string {
  for (const pkg of packages) {
    if (pkg.name.endsWith('/*')) {
      if (filePath.startsWith(pkg.prefix)) {
        // Extract the actual subpackage name (e.g., 'cli/cella' from 'cli/cella/src/foo.ts')
        const rest = filePath.slice(pkg.prefix.length);
        const subDir = rest.split('/')[0];
        if (subDir) {
          return `${pkg.prefix}${subDir}`;
        }
      }
    } else if (filePath.startsWith(pkg.prefix)) {
      return pkg.name;
    }
  }
  return '(root)';
}
