/**
 * Tests for the branch mode of the stats service (`cella stats --since <ref>`).
 *
 * The parsers run on literal git output; `collectBranchStats` runs on a real repo, so the numstat
 * and patch readings are checked against each other.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyChange,
  classifyLine,
  collectBranchStats,
  countLineContent,
  formatMarkdown,
  parseNumstat,
} from '../src/services/stats-since';

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function commit(dir: string, message: string): void {
  exec(`git add -A && git commit -m "${message}"`, dir);
}

describe('classifyChange', () => {
  it('reads each kind of file from its path', () => {
    const kinds = Object.fromEntries(
      [
        'frontend/src/query/on-error.ts',
        'frontend/src/styling/app.css',
        'frontend/src/query/tests/on-error.test.ts',
        'backend/tests/helpers.ts',
        'frontend/src/modules/ui/stories/toast.stories.tsx',
        'sdk/gen/types.gen.ts',
        'backend/drizzle/0001_init.sql',
        'pnpm-lock.yaml',
        'locales/en/error.json',
        'cella/AGENTS.md',
        'frontend/src/content/intro.mdx',
        '.github/workflows/ci.yml',
        'Dockerfile',
      ].map((file) => [file, classifyChange(file)]),
    );

    expect(kinds).toEqual({
      'frontend/src/query/on-error.ts': 'source',
      'frontend/src/styling/app.css': 'source',
      'frontend/src/query/tests/on-error.test.ts': 'test',
      'backend/tests/helpers.ts': 'test',
      'frontend/src/modules/ui/stories/toast.stories.tsx': 'stories',
      'sdk/gen/types.gen.ts': 'generated',
      'backend/drizzle/0001_init.sql': 'generated',
      'pnpm-lock.yaml': 'generated',
      'locales/en/error.json': 'json',
      'cella/AGENTS.md': 'docs',
      'frontend/src/content/intro.mdx': 'docs',
      '.github/workflows/ci.yml': 'other',
      Dockerfile: 'other',
    });
  });
});

describe('classifyLine', () => {
  it('tells comments and blank lines from code by how the line starts', () => {
    expect(['', '   ', '\t'].map(classifyLine)).toEqual(['blank', 'blank', 'blank']);
    expect(['// note', '  /** Doc. */', '   * body of a block', '   */', '{/* jsx */}'].map(classifyLine)).toEqual([
      'comments',
      'comments',
      'comments',
      'comments',
      'comments',
    ]);
    expect(['const a = 1; // trailing', 'return a * b;', '}', '<div />'].map(classifyLine)).toEqual([
      'code',
      'code',
      'code',
      'code',
    ]);
  });
});

describe('parseNumstat', () => {
  it('reads one record per file, a binary file as zero lines', () => {
    const output = ['12\t3\tsrc/a.ts', '-\t-\tassets/logo.png', '0\t40\tsrc/tab\tname.ts', ''].join('\0');

    expect(parseNumstat(output)).toEqual([
      { path: 'src/a.ts', kind: 'source', added: 12, removed: 3 },
      { path: 'assets/logo.png', kind: 'other', added: 0, removed: 0 },
      { path: 'src/tab\tname.ts', kind: 'source', added: 0, removed: 40 },
    ]);
  });
});

describe('countLineContent', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3 +3,4 @@ export const a = 1;',
    '-const old = 1;',
    '+/** Doubles a number. */',
    '+const double = (n: number) => n * 2;',
    '+',
    // A changed line that looks like a file header once its sign is in front
    '+++ b/src/skipped.ts',
    '\\ No newline at end of file',
    'diff --git a/src/skipped.ts b/src/skipped.ts',
    '--- a/src/skipped.ts',
    '+++ b/src/skipped.ts',
    '@@ -0,0 +1,2 @@',
    '+const ignored = true;',
    '+// ignored',
    'diff --git "a/src/qu\\303\\266ted.ts" "b/src/qu\\303\\266ted.ts"',
    '--- "a/src/qu\\303\\266ted.ts"',
    '+++ "b/src/qu\\303\\266ted.ts"',
    '@@ -1 +0,0 @@',
    '-const gone = true;',
    'diff --git a/src/removed.ts b/src/removed.ts',
    'deleted file mode 100644',
    '--- a/src/removed.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-// header',
    '-export const removed = 1;',
  ].join('\n');

  it('counts the lines of accepted files by what they hold, keeping to the line counts of each hunk', () => {
    const counted = new Set(['src/a.ts', 'src/removed.ts']);

    expect(countLineContent(patch, (file) => counted.has(file))).toEqual({
      code: { added: 2, removed: 2 },
      comments: { added: 1, removed: 1 },
      blank: { added: 1, removed: 0 },
    });
  });

  it('counts nothing for a file whose path git quoted, and never under the file before it', () => {
    expect(countLineContent(patch, (file) => file === 'src/skipped.ts')).toEqual({
      code: { added: 1, removed: 0 },
      comments: { added: 1, removed: 0 },
      blank: { added: 0, removed: 0 },
    });
  });
});

describe('collectBranchStats', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-stats-since-'));
    // -b main: don't depend on the runner's init.defaultBranch (CI defaults to master).
    exec('git init -b main', dir);
    exec('git config user.email "test@test.com" && git config user.name "Test"', dir);
    write(dir, 'pnpm-workspace.yaml', 'packages:\n  - frontend\n  - backend\n');
    write(dir, 'frontend/src/app.ts', 'export const app = 1;\nexport const old = 2;\n');
    write(dir, 'backend/src/server.ts', '// Starts the server\nexport const server = 1;\n');
    write(dir, 'locales/en/common.json', '{\n  "hello": "Hello"\n}\n');
    commit(dir, 'initial');

    exec('git checkout -b feature', dir);
    write(dir, 'frontend/src/app.ts', 'export const app = 1;\n\n/** The new thing. */\nexport const fresh = 3;\n');
    write(dir, 'frontend/src/app.test.ts', "import { app } from './app';\n\ntest('app', () => expect(app).toBe(1));\n");
    write(dir, 'backend/src/server.ts', 'export const server = 1;\n');
    write(dir, 'locales/en/common.json', '{\n  "bye": "Bye",\n  "hello": "Hello"\n}\n');
    write(dir, 'docs/guide.md', '# Guide\n\nRead this.\n');
    write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    commit(dir, 'feature');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts the committed changes of the branch by kind of file', async () => {
    const stats = await collectBranchStats(dir, 'main');

    expect(stats.head).toBe('feature');
    expect(stats.total).toEqual({ files: 6, added: 11, removed: 2 });
    expect(stats.kinds).toEqual({
      source: { files: 2, added: 3, removed: 2 },
      test: { files: 1, added: 3, removed: 0 },
      stories: { files: 0, added: 0, removed: 0 },
      generated: { files: 1, added: 1, removed: 0 },
      json: { files: 1, added: 1, removed: 0 },
      docs: { files: 1, added: 3, removed: 0 },
      other: { files: 0, added: 0, removed: 0 },
    });
    expect(stats.files.map((file) => file.path)).toEqual([
      'docs/guide.md',
      'frontend/src/app.test.ts',
      'frontend/src/app.ts',
      'locales/en/common.json',
      'pnpm-lock.yaml',
      'backend/src/server.ts',
    ]);
  });

  it('splits the source lines by content and by package, adding up to the lines of the source files', async () => {
    const stats = await collectBranchStats(dir, 'main');

    expect(stats.sourceContent).toEqual({
      code: { added: 1, removed: 1 },
      comments: { added: 1, removed: 1 },
      blank: { added: 1, removed: 0 },
    });
    expect(stats.sourceByPackage).toEqual({
      frontend: { files: 1, added: 3, removed: 1 },
      backend: { files: 1, added: 0, removed: 1 },
    });

    const content = Object.values(stats.sourceContent ?? {});
    expect(content.reduce((sum, change) => sum + change.added, 0)).toBe(stats.kinds.source.added);
    expect(content.reduce((sum, change) => sum + change.removed, 0)).toBe(stats.kinds.source.removed);
  });

  it('compares with the commit the branch left the ref at, and leaves uncommitted work out', async () => {
    exec('git checkout main', dir);
    write(dir, 'frontend/src/later.ts', 'export const later = 1;\n');
    commit(dir, 'main moved on');
    const base = exec('git rev-parse --short=7 HEAD~1', dir);
    exec('git checkout feature', dir);
    write(dir, 'frontend/src/draft.ts', 'export const draft = 1;\n');

    const stats = await collectBranchStats(dir, 'main');

    expect(stats.mergeBase).toBe(base);
    expect(stats.total.files).toBe(6);
    expect(stats.files.map((file) => file.path)).not.toContain('frontend/src/later.ts');
    expect(stats.uncommitted).toBe(1);
  });

  it('refuses a ref that does not exist', async () => {
    await expect(collectBranchStats(dir, 'origin/nope')).rejects.toThrow("unknown ref 'origin/nope'");
  });

  it('formats a table for a pull request description, the kind that grew most first', async () => {
    const stats = await collectBranchStats(dir, 'main');

    expect(formatMarkdown(stats)).toBe(
      [
        '| Kind | Files | Added | Removed | Net |',
        '| --- | ---: | ---: | ---: | ---: |',
        '| Tests | 1 | +3 | 0 | +3 |',
        '| Docs | 1 | +3 | 0 | +3 |',
        '| Source | 2 | +3 | -2 | +1 |',
        '| Generated | 1 | +1 | 0 | +1 |',
        '| JSON | 1 | +1 | 0 | +1 |',
        '| **Total** | **6** | **+11** | **-2** | **+9** |',
        '',
        'Source lines by content: code 0, comments 0, blank +1.',
        'Source lines by package: frontend +2, backend -1.',
      ].join('\n'),
    );
  });
});
