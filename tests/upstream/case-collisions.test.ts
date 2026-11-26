import { expect, it } from 'vitest';
import { caseCollisions, classifyFiles } from '../../src/upstream/classify';
import { isUnderAnyFolder } from '../../src/upstream/protection';
import { trees } from '../helpers/test-env';

interface Case {
  name: string;
  base: Record<string, string>;
  app: Record<string, string>;
  upstream: Record<string, string>;
  upstreamMoves?: Record<string, string>;
  /** New path onto the path the app moved a file away from. */
  appMoves?: Record<string, string>;
  /** The same for a move with an edit, which git's merge follows at 50% similarity and `-M90%` reads as an add and a delete. */
  appEditMoves?: Record<string, string>;
  pinned?: string[];
  ignored?: string[];
  expected: [string, string][];
}

const cases: Case[] = [
  {
    name: 'refuses a file variant of a pinned file',
    base: { 'cella/cella.config.ts': 'app' },
    app: { 'cella/cella.config.ts': 'app' },
    upstream: { 'cella/cella.config.ts': 'app', 'cella/Cella.config.ts': 'variant' },
    pinned: ['cella/cella.config.ts'],
    expected: [['cella/Cella.config.ts', 'cella/cella.config.ts']],
  },
  {
    name: 'refuses a folder variant of a pinned folder',
    base: { 'pinned/keep.ts': 'a' },
    app: { 'pinned/keep.ts': 'a' },
    upstream: { 'pinned/keep.ts': 'a', 'Pinned/new.ts': 'variant' },
    pinned: ['pinned'],
    expected: [['Pinned', 'pinned']],
  },
  {
    // Resolves to `keep` with no app copy: the upgrade would delete `own/Key.ts`, the app's `own/key.ts` on a case-insensitive disk
    name: 'refuses a variant under an ignored entry',
    base: { 'README.md': 'a' },
    app: { 'README.md': 'a', 'own/key.ts': 'app' },
    upstream: { 'README.md': 'a', 'own/Key.ts': 'variant' },
    ignored: ['own'],
    expected: [['own/Key.ts', 'own/key.ts']],
  },
  {
    name: "passes upstream's case-only rename",
    base: { 'docs/Readme.md': 'a' },
    app: { 'docs/Readme.md': 'a' },
    upstream: { 'docs/README.md': 'a' },
    upstreamMoves: { 'docs/README.md': 'docs/Readme.md' },
    expected: [],
  },
  {
    name: "passes the app's own case-only rename that upstream later edits",
    base: { 'src/Foo.ts': 'a' },
    app: { 'src/foo.ts': 'a' },
    upstream: { 'src/Foo.ts': 'b' },
    appMoves: { 'src/foo.ts': 'src/Foo.ts' },
    expected: [],
  },
  {
    name: "passes the app's own case-only rename with an edit that upstream later edits",
    base: { 'src/Foo.ts': 'a' },
    app: { 'src/foo.ts': 'a2' },
    upstream: { 'src/Foo.ts': 'b' },
    appEditMoves: { 'src/foo.ts': 'src/Foo.ts' },
    expected: [],
  },
];

it.each(cases)(
  '$name',
  ({ base, app, upstream, upstreamMoves, appMoves = {}, appEditMoves = {}, pinned = [], ignored = [], expected }) => {
    const tree = trees(base, app, upstream, upstreamMoves);
    for (const [to, from] of Object.entries(appMoves)) {
      tree.appChanges.delete(from);
      tree.appChanges.delete(to);
      tree.appChanges.set(to, { status: 'R', oldPath: from, baseHash: base[from], targetHash: app[to] });
    }
    const files = classifyFiles(tree, {
      isIgnored: (path) => isUnderAnyFolder(path, ignored),
      isPinned: (path) => isUnderAnyFolder(path, pinned),
    });

    const appMoved = new Set([...Object.values(appMoves), ...Object.values(appEditMoves)]);
    expect(caseCollisions(tree, files, appMoved)).toEqual(expected);
  },
);
