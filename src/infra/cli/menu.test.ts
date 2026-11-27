import { stripVTControlCharacters } from 'node:util';
import { Separator } from '@inquirer/core';
import { describe, expect, it } from 'vitest';
import type { MenuItem } from '../../utils/menu';
import { backChoice, disabledReason, type MenuState, mainMenuItems, pickItems, quitChoice, rowDisabledReason, upNext, visibleRows } from './menu';

const bootstrapped: MenuState = { stackState: 'bootstrapped', environment: 'staging', dbExposed: false };
const partial: MenuState = { ...bootstrapped, stackState: 'partial' };

const plain = (text: string) => stripVTControlCharacters(text);

/** The menu as an operator reads it: one line per item, group headings flush left, disabled entries as the prompt renders them. */
function render(items: Array<MenuItem<string>>): string[] {
  return items.map((item) => {
    if (item instanceof Separator) return ` ${plain(item.separator)}`;
    if ('group' in item) return item.group;
    return item.disabled ? `- ${plain(item.name)} ${item.disabled}` : `  ${plain(item.name)}`;
  });
}

describe('mainMenuItems', () => {
  it('leads with the recommended step when the home screen has one', () => {
    const items = mainMenuItems({ ...bootstrapped, upNext: { action: 'deploy-now', description: 'Deploy 0.35.0 again' } });
    expect(render(items).slice(0, 2)).toEqual(['  ▶  Deploy 0.35.0 again', '']);
    expect(items[0]).toMatchObject({ value: upNext });
  });

  it('keeps every row on a stack whose setup is unfinished and says why a row cannot run', () => {
    expect(render(mainMenuItems(partial)).filter((line) => line.startsWith('-'))).toEqual([
      '- apply (needs a set-up environment: run "more › resume")',
      '- releases (needs a set-up environment: run "more › resume")',
      '- db-open (needs a set-up environment: run "more › resume")',
    ]);
  });

  it('shows the close row while the exposure config says open', () => {
    const lines = render(mainMenuItems({ ...bootstrapped, dbExposed: true }));
    expect(lines.some((line) => line.startsWith('  db-close (OPEN)  '))).toBe(true);
    expect(lines.some((line) => line.includes('db-open'))).toBe(false);
  });

  it('shows the close row for a live endpoint no exposure config accounts for, and names it', () => {
    const items = mainMenuItems({ ...bootstrapped, liveEndpoints: ['51.15.0.1:5432'] });
    const row = items.find((item) => 'value' in item && item.value === 'db-close');
    expect(row && 'name' in row ? plain(row.name) : '').toContain('db-close (OPEN)');
    expect(row && 'description' in row ? row.description : '').toContain('51.15.0.1:5432');
  });

  it('follows the exposure config when the instance was not read or has no endpoint', () => {
    expect(visibleRows({ ...bootstrapped, liveEndpoints: undefined })).toContain('db-open');
    expect(visibleRows({ ...bootstrapped, liveEndpoints: [] })).toContain('db-open');
    expect(visibleRows({ ...bootstrapped, liveEndpoints: [] })).not.toContain('db-close');
  });

  it('fits every row on one 80-column line and every description on one 96-column line that names no key, in every state', () => {
    const states: MenuState[] = [
      bootstrapped,
      partial,
      { ...bootstrapped, environment: 'production', dbExposed: true },
      { ...bootstrapped, liveEndpoints: ['51.15.0.1:5432'] },
      { ...partial, environment: 'production', dbExposed: true },
    ];
    for (const state of states) {
      const menus = [mainMenuItems(state), ...visibleRows(state).map((id) => pickItems(id, state))];
      for (const items of menus) {
        for (const line of render(items)) expect(line.length).toBeLessThanOrEqual(80);
        for (const item of items) {
          const description = 'description' in item ? (item.description ?? '') : '';
          expect(description.length).toBeLessThanOrEqual(96);
          expect(description).not.toMatch(/destructive|observer key|operator key|owner key/i);
        }
      }
    }
  });

  it('ends with the way out: Quit, or Back when the package menu opened the CLI', () => {
    expect(mainMenuItems(bootstrapped).at(-1)).toMatchObject({ name: 'Quit', value: quitChoice });
    expect(mainMenuItems(bootstrapped, true).at(-1)).toMatchObject({ name: '← Back', value: quitChoice });
  });
});

describe('pickItems', () => {
  it('lists the rare actions with their summaries and a rule between sections, then Back', () => {
    const rule = ` ${'─'.repeat(40)}`;
    expect(render(pickItems('more', { ...bootstrapped, environment: 'production' }))).toEqual([
      '  deploy-now      without waiting for the scheduled run',
      '  preview         what apply would change; read-only',
      rule,
      '  rotate-keys     new deploy and uploads keys, then a redeploy',
      '  rotate-secrets  new passwords and generated values, redeployed',
      '  operators       make or repair the operator app and group',
      '  identities      write what differs from the declared identities',
      '  repository-key  the GitHub key a private repository needs',
      rule,
      '  unlock          clear the lease a stopped run left',
      '  resume          continue an interrupted setup',
      '  state-remove    drop a gone resource from the Pulumi state',
      rule,
      '- db-seed (seed data never goes to production)',
      '  db-reset        wipe and rebuild it empty, after a backup',
      rule,
      '  env-import      set the values a .env file holds',
      '  teardown        delete all that runs or costs, after a final dump',
      rule,
      '  ← Back to menu',
    ]);
    expect(pickItems('more', bootstrapped).at(-1)).toMatchObject({ value: backChoice });
  });
});

describe('disabledReason', () => {
  it('refuses seed data on production and allows a reset there', () => {
    const production: MenuState = { ...bootstrapped, environment: 'production' };
    expect(disabledReason('db-seed', production)).toBe('seed data never goes to production');
    expect(disabledReason('db-reset', production)).toBeUndefined();
  });

  it('leaves the actions that repair a stack available on an unfinished one', () => {
    for (const id of ['resume', 'rotate-keys', 'unlock', 'teardown', 'env', 'status'] as const) {
      expect(disabledReason(id, partial)).toBeUndefined();
    }
  });
});

describe('rowDisabledReason', () => {
  it('disables a row only when every action behind it is blocked', () => {
    expect(rowDisabledReason('apply', partial)).toBe('needs a set-up environment: run "more › resume"');
    expect(rowDisabledReason('more', partial)).toBeUndefined();
  });
});
