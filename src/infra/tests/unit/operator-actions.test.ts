import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentedTasks } from '../../cli/help';
import {
  actionCommand,
  isOperatorActionId,
  type MenuRowId,
  menuPath,
  menuRow,
  menuRows,
  type OperatorActionId,
  operatorActions,
} from '../../lib/operator-actions';

const infraRoot = path.resolve(import.meta.dirname, '../..');
const repoRoot = path.resolve(infraRoot, '..');

const ids = Object.keys(operatorActions) as OperatorActionId[];
const rowIds = Object.keys(menuRows) as MenuRowId[];
const rowLabels = rowIds.map((id) => menuRow(id).label);

/** Names an action or a submenu carried before the menu showed command words. None may come back in a message, a comment or the docs. */
const retiredLabels = [
  'Open temporary public DB access',
  'Expose database publicly',
  'Stop public DB exposure',
  'Public DB access: OPEN',
  'Apply infra change',
  'Apply changes',
  'Store passphrase in keychain',
  'Rotate passphrase',
  'Recovery passphrase',
  'recovery passphrase',
  'Manage keys & secrets',
  'Manage database',
  'Set up operator key',
  'Stack setup →',
  '"Stack setup"',
  'Show status',
  'Show runs',
  'Manage runtime secrets',
  'Open public DB access',
  'Close public DB access',
  'Rotate keys & secrets',
  'Repair stack',
  'Tear down stack',
  'Unlock stack',
  'Start a deploy',
  'Keys & operators',
  'Operators & keys',
  'Infrastructure changes',
  'Full status',
  'Deploy logs',
  'Preview changes',
  'Review & apply',
  'Set up operators',
  'Update identities',
  'Releases & roll back',
  'Set repository read key',
  'Env vars & secrets',
  'Import a .env file',
  'Open DB access',
  'Seed database',
  'Close DB access',
  'Reset database',
  'Resume setup',
  'Remove from state',
  'More →',
];

/** The engine's own docs; the template checks its docs against the same table. */
const docs = ['infra/README.md', 'infra/tasks/README.md'];

/** Every TypeScript source file of the infra package, relative to the repo root. */
function infraSources(dir = infraRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return infraSources(full);
    return entry.name.endsWith('.ts') ? [path.relative(repoRoot, full)] : [];
  });
}

describe('operator action table', () => {
  it('uses command-shaped ids: lowercase words joined by hyphens', () => {
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(isOperatorActionId('apply')).toBe(true);
    expect(isOperatorActionId('toString')).toBe(false);
    expect(actionCommand('db-close')).toBe('pnpm cella infra db-close');
  });
});

describe('menu rows', () => {
  it('lists only actions that exist, each in one row', () => {
    const listed = rowIds.flatMap((id) => [...menuRow(id).actions]);
    for (const action of listed) expect(ids).toContain(action);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('keeps the menu to six daily rows and More: the two DB access rows share one place', () => {
    expect(rowIds).toHaveLength(8);
    expect(rowIds).toContain('db-open');
    expect(rowIds).toContain('db-close');
  });

  it('gives every action a row, so nothing is reached by its command alone', () => {
    const listed = new Set(rowIds.flatMap((id) => [...menuRow(id).actions]));
    expect(ids.filter((id) => !listed.has(id))).toEqual([]);
  });

  it('says where an action is found by its command words: the row, or the pick inside a row', () => {
    expect(menuPath('status')).toBe('status');
    expect(menuPath('db-close')).toBe('db-close');
    expect(menuPath('db-seed')).toBe('more › db-seed');
    expect(menuPath('rotate-keys')).toBe('more › rotate-keys');
  });
});

describe('one name per action', () => {
  it('keeps retired labels out of the source and the docs', () => {
    const self = path.relative(repoRoot, import.meta.filename);
    const hits = [...docs, ...infraSources().filter((file) => file !== self)].flatMap((file) => {
      const text = readFileSync(path.join(repoRoot, file), 'utf8');
      return retiredLabels.filter((label) => text.includes(label)).map((label) => `${file}: ${label}`);
    });
    expect(hits).toEqual([]);
  });

  it('points the docs at menu entries and commands that exist', () => {
    const known = new Set<string>([...ids, ...rowLabels]);
    const unknown: string[] = [];
    for (const file of docs) {
      const text = readFileSync(path.join(repoRoot, file), 'utf8');
      // `pnpm cella infra` → **Row** (→ **Action**), and the command form `pnpm cella infra <action or task>`.
      for (const match of text.matchAll(/`pnpm cella infra` → \*\*([^*]+)\*\*(?: → \*\*([^*]+)\*\*)?/g)) {
        for (const name of [match[1], match[2]]) if (name && !known.has(name)) unknown.push(`${file}: ${name}`);
      }
      for (const match of text.matchAll(/pnpm cella infra ([a-z][a-z-]*)/g)) {
        const word = match[1] ?? '';
        if (word !== 'help' && !isOperatorActionId(word) && !documentedTasks.includes(word)) unknown.push(`${file}: pnpm cella infra ${word}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
