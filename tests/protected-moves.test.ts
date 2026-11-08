/**
 * Tests for protected files arriving and moving by path.
 *
 * git pairs renames by content, so identical or near-identical copies in a moved folder can pair
 * crosswise, and a copy whose content pairs nowhere arrives as delete plus add. For a protected
 * file the pair decides which local bytes land where, so a wrong pair crosses app files
 * (projectcampus: its nl/app.json content arrived as nl/about.json) and a missing one drops the
 * app's copy for upstream's. `repairIncomingRenames` re-aims the pairs by path, and `analyzeRefs`
 * classifies a pinned path that is new in upstream as `behind`, so upstream's copy arrives as the
 * fork's first one.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRefs, repairIncomingRenames } from '../src/services/analyze-core';
import type { FileChange } from '../src/utils/git';
import { getMergeBase } from '../src/utils/git';
import { createRepo, exec, write } from './helpers/test-env';

const rename = (oldPath: string): FileChange => ({ status: 'R', oldPath, baseHash: 'base', targetHash: 'target' });
const added: FileChange = { status: 'A', baseHash: null, targetHash: 'target' };
const deleted: FileChange = { status: 'D', baseHash: 'base', targetHash: null };

/** A repair context over explicit path lists; every path counts as protected unless named. */
function context(options: { base: string[]; incoming: string[]; local: string[]; unprotected?: string[] }) {
  return {
    basePaths: new Set(options.base),
    incomingPaths: new Set(options.incoming),
    localPaths: new Set(options.local),
    isProtected: (path: string) => !options.unprotected?.includes(path),
  };
}

describe('repairIncomingRenames', () => {
  it('re-aims crossed pairs of a moved folder as a swap', () => {
    const changes = new Map<string, FileChange>([
      ['shared/nl/about.json', rename('locales/nl/app.json')],
      ['shared/nl/app.json', rename('locales/nl/about.json')],
      // The same-named pair that maps the directory.
      ['shared/nl/common.json', rename('locales/nl/common.json')],
    ]);
    const olds = ['locales/nl/app.json', 'locales/nl/about.json', 'locales/nl/common.json'];
    const news = ['shared/nl/app.json', 'shared/nl/about.json', 'shared/nl/common.json'];
    repairIncomingRenames(changes, context({ base: olds, incoming: news, local: olds }));

    expect(changes.get('shared/nl/app.json')?.oldPath).toBe('locales/nl/app.json');
    expect(changes.get('shared/nl/about.json')?.oldPath).toBe('locales/nl/about.json');
    expect(changes.get('shared/nl/common.json')?.oldPath).toBe('locales/nl/common.json');
  });

  it('pairs a protected copy incoming carries as delete plus add', () => {
    const changes = new Map<string, FileChange>([
      ['shared/nl/common.json', rename('locales/nl/common.json')],
      ['shared/nl/appError.json', added],
      ['locales/nl/appError.json', deleted],
    ]);
    const olds = ['locales/nl/common.json', 'locales/nl/appError.json'];
    const news = ['shared/nl/common.json', 'shared/nl/appError.json'];
    repairIncomingRenames(changes, context({ base: olds, incoming: news, local: olds }));

    expect(changes.get('shared/nl/appError.json')).toEqual({
      status: 'R',
      oldPath: 'locales/nl/appError.json',
      baseHash: null,
      targetHash: 'target',
    });
    expect(changes.has('locales/nl/appError.json')).toBe(false);
  });

  it('leaves an unprotected delete plus add and a true rename alone', () => {
    const changes = new Map<string, FileChange>([
      ['shared/nl/common.json', rename('locales/nl/common.json')],
      ['shared/nl/plain.json', added],
      ['locales/nl/plain.json', deleted],
      ['src/new-name.ts', rename('src/old-name.ts')],
    ]);
    const olds = ['locales/nl/common.json', 'locales/nl/plain.json', 'src/old-name.ts'];
    const news = ['shared/nl/common.json', 'shared/nl/plain.json', 'src/new-name.ts'];
    repairIncomingRenames(
      changes,
      context({ base: olds, incoming: news, local: olds, unprotected: ['locales/nl/plain.json'] }),
    );

    expect(changes.get('shared/nl/plain.json')).toEqual(added);
    expect(changes.get('locales/nl/plain.json')).toEqual(deleted);
    expect(changes.get('src/new-name.ts')?.oldPath).toBe('src/old-name.ts');
  });

  it('keeps git pairing whole when the repaired pairs would collide', () => {
    const changes = new Map<string, FileChange>([
      ['b/y.json', rename('a/x.json')],
      ['b/z.json', rename('c/x.json')],
      ['b/x.json', added],
    ]);
    const olds = ['a/x.json', 'c/x.json'];
    const news = ['b/x.json', 'b/y.json', 'b/z.json'];
    repairIncomingRenames(changes, context({ base: olds, incoming: news, local: olds }));

    expect(changes.get('b/y.json')?.oldPath).toBe('a/x.json');
    expect(changes.get('b/z.json')?.oldPath).toBe('c/x.json');
    expect(changes.get('b/x.json')).toEqual(added);
  });

  it('never re-aims onto a path that existed at the merge-base', () => {
    const changes = new Map<string, FileChange>([['b/y.json', rename('a/x.json')]]);
    repairIncomingRenames(
      changes,
      context({ base: ['a/x.json', 'b/x.json'], incoming: ['b/x.json', 'b/y.json'], local: ['a/x.json'] }),
    );

    expect(changes.get('b/y.json')?.oldPath).toBe('a/x.json');
    expect(changes.has('b/x.json')).toBe(false);
  });
});

/**
 * Repo with a `main` (fork) and `upstream` branch off one base commit. The base holds
 * `locales/nl/` where app.json, about.json and appError.json are byte-identical (`{}`), the shape
 * that lets git pair them crosswise or not at all; upstream moves the folder to `shared/locales/`
 * and the fork fills each file with its own content.
 */
function createMovedFolderRepo(): string {
  const dir = createRepo('cella-protected-moves-');
  write(dir, {
    'locales/nl/app.json': '{}\n',
    'locales/nl/about.json': '{}\n',
    'locales/nl/appError.json': '{}\n',
    'locales/nl/common.json': '{"back":"Terug","cancel":"Annuleren","close":"Sluiten","save":"Opslaan"}\n',
    'src/index.ts': 'export {};\n',
  });
  exec('git add -A && git commit -q -m base', dir);

  exec('git checkout -q -b upstream', dir);
  exec('mkdir -p shared && git mv locales shared/locales', dir);
  exec('git commit -q -m "chore: locales into shared"', dir);

  exec('git checkout -q main', dir);
  write(dir, {
    'locales/nl/app.json': '{"app_title":"Fork app"}\n',
    'locales/nl/about.json': '{"about_us":"Over het fork"}\n',
    'locales/nl/appError.json': '{"fork_error":"Fork fout"}\n',
    'locales/nl/common.json':
      '{"back":"Terug","cancel":"Annuleren","close":"Sluiten","save":"Opslaan","fork":"Fork"}\n',
  });
  exec('git add -A && git commit -q -m fork', dir);
  return dir;
}

describe('analyzeRefs protected moves', () => {
  it('carries every protected file of a moved folder by its own path', async () => {
    const repoPath = createMovedFolderRepo();
    const mergeBase = await getMergeBase(repoPath, 'main', 'upstream');
    const files = await analyzeRefs(repoPath, 'main', 'upstream', mergeBase, {
      isIgnored: (path) => path.startsWith('locales/') || path.startsWith('shared/locales/'),
      isPinned: () => false,
    });
    const byPath = new Map(files.map((file) => [file.path, file]));

    for (const name of ['app.json', 'about.json', 'appError.json', 'common.json']) {
      const file = byPath.get(`shared/locales/nl/${name}`);
      expect(file?.status, name).toBe('pinned');
      expect(file?.renamedFrom, name).toBe(`locales/nl/${name}`);
    }
  });

  it('classifies a pinned path new in upstream as behind, so the first copy arrives', async () => {
    const repoPath = createRepo('cella-pinned-arrival-', { 'src/index.ts': 'export {};\n' });
    exec('git checkout -q -b upstream', repoPath);
    write(repoPath, { 'seeds/showcase.json': '{"organizations":[]}\n' });
    exec('git add -A && git commit -q -m "feat: showcase seed"', repoPath);
    exec('git checkout -q main', repoPath);

    const mergeBase = await getMergeBase(repoPath, 'main', 'upstream');
    const files = await analyzeRefs(repoPath, 'main', 'upstream', mergeBase, {
      isIgnored: () => false,
      isPinned: (path) => path === 'seeds/showcase.json',
    });
    const file = files.find((entry) => entry.path === 'seeds/showcase.json');

    expect(file?.status).toBe('behind');
    expect(file?.isPinned).toBe(true);
    expect(file?.existsInFork).toBe(false);
  });
});
