import { describe, expect, it } from 'vitest';
import { compare, placeholdersOf, pluralGaps, tagsOf } from '../src/tools/i18n/parity';

describe('i18n placeholder and tag parity', () => {
  const cases: [
    label: string,
    english: string,
    translation: string,
    extract: (text: string) => string[],
    missing: string[],
    extra: string[],
  ][] = [
    ['a dropped interpolation', 'Hi {{name}}', 'Hoi', placeholdersOf, ['name'], []],
    ['a renamed interpolation', 'Hi {{name}}', 'Hoi {{naam}}', placeholdersOf, ['name'], ['naam']],
    ['a format is no name', 'Create {{resource, lowercase}}', 'Maak {{resource}}', placeholdersOf, [], []],
    ['an unescaped interpolation', 'By {{- name}}', 'Door {{name}}', placeholdersOf, [], []],
    ['a nested key', '$t(c:accept) now', 'Nu', placeholdersOf, ['$t(c:accept)'], []],
    ['a repeated interpolation counts once', '{{n}} of {{n}}', '{{n}}', placeholdersOf, [], []],
    ['a dropped tag', 'Delete <strong>{{name}}</strong>?', 'Verwijder {{name}}?', tagsOf, ['strong'], []],
    ['self-closing spellings match', 'One<br/>two', 'Een<br />twee', tagsOf, [], []],
    ['a component index', '<0>Open</0>', '<1>Open</1>', tagsOf, ['0'], ['1']],
    [
      'a second tag of one name',
      '<strong>a</strong> <strong>b</strong>',
      '<strong>a b</strong>',
      tagsOf,
      ['strong'],
      [],
    ],
  ];

  for (const [label, english, translation, extract, missing, extra] of cases) {
    it(label, () => {
      const mismatch = compare('key', english, translation, extract);
      expect(mismatch ? [mismatch.missing, mismatch.extra] : [[], []]).toEqual([missing, extra]);
    });
  }
});

describe('i18n plural gaps', () => {
  const cases: [
    label: string,
    english: Record<string, string>,
    texts: Record<string, string>,
    language: string,
    gaps: string[],
  ][] = [
    [
      'a base covers the one form',
      { member: 'Member', member_other: 'Members' },
      { member: 'Lid', member_other: 'Leden' },
      'nl',
      [],
    ],
    [
      'the other form without a base',
      { count_one: 'One', count_other: 'Many' },
      { count_one: 'Een' },
      'nl',
      ['count -other'],
    ],
    [
      'a form a language never uses',
      { count_one: 'One', count_other: 'Many' },
      { count_one: 'x', count_other: 'y' },
      'ja',
      ['count +one'],
    ],
    [
      'forms English has no word for',
      { count_one: 'One', count_other: 'Many' },
      { count_one: 'a', count_other: 'b' },
      'pl',
      ['count -few -many'],
    ],
    ['an _other key called by its full name', { item_other: 'Items' }, { item_other: 'Items' }, 'nl', []],
    ['a one form without its other form is a plain key', { send_one: 'Send one' }, {}, 'nl', []],
    ['a group a language has not started', { count_one: 'One', count_other: 'Many' }, {}, 'pl', []],
    [
      'English itself',
      { count_one: 'One', count_two: 'Two', count_other: 'Many' },
      { count_one: 'One', count_two: 'Two', count_other: 'Many' },
      'en',
      ['count +two'],
    ],
    [
      'ordinals by the ordinal categories',
      { place_ordinal_one: '1st', place_ordinal_two: '2nd', place_ordinal_few: '3rd', place_ordinal_other: 'th' },
      { place_ordinal_other: 'e' },
      'nl',
      [],
    ],
  ];

  for (const [label, english, texts, language, gaps] of cases) {
    it(label, () => {
      const found = pluralGaps(english, texts, language).map(({ key, missing, extra }) =>
        [key, ...missing.map((form) => `-${form}`), ...extra.map((form) => `+${form}`)].join(' '),
      );
      expect(found).toEqual(gaps);
    });
  }
});
