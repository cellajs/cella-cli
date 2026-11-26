import { Help } from 'commander';
import { menuRows, moreSections, type OperatorActionId, operatorActions } from '../lib/operator-actions';

type Item = [term: string, text: string];

const runOptions: Item[] = [
  ['--mode <production|staging>', 'the environment; INFRA_MODE sets it too'],
  ['--once', 'leave after the first action chosen in the menu'],
  ['--defaults', 'take every optional default; required inputs are still asked'],
  ['-h, --help', 'display this help'],
];

const actionOptions: Item[] = [
  ['--sha <sha>', "logs: every boot account of that release, with the builder's report"],
  ['--machines', 'logs: the newest boot account of each service'],
  ['--debug-provider', 'apply: keep the engine and provider log under infra/.debug/'],
];

const actionItems = (ids: readonly OperatorActionId[]): Item[] => ids.map((id) => [id, operatorActions[id].summary]);

/**
 * The page `cella help infra`, `cella infra help` and `cella infra <action> --help` print, 80 columns wide in Commander's layout: the
 * actions as the menu groups them, each with its summary, and every flag the engine reads. It reads no app config.
 */
export function infraHelp(): string {
  const help = Object.assign(new Help(), { helpWidth: 80 });
  const daily = Object.values(menuRows).flatMap((row) => (row === menuRows.more ? [] : row.actions));
  const sections: [heading: string, items: Item[]][] = [
    ['Options:', runOptions],
    ['Daily actions:', actionItems(daily)],
    ...Object.entries(moreSections).map(([name, ids]): [string, Item[]] => [`${name}:`, actionItems(ids)]),
    ['Options of one action:', actionOptions],
  ];
  const width = Math.max(...sections.flatMap(([, items]) => items.map(([term]) => term.length)));
  return [
    'Usage: cella infra [action] [options]',
    '',
    help.boxWrap("set up, apply and deploy the app's environments; without an action the menu opens on the home screen", 80),
    '',
    ...sections.flatMap(([heading, items]) => [heading, ...items.map(([term, text]) => help.formatItem(term, width, text, help)), '']),
    help.boxWrap("Other first words are tasks: the app's scripts and the main job run them, and a person does not type them.", 80),
    '',
  ].join('\n');
}
