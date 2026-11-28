import { a11yCommand } from './a11y';
import { auditCommand } from './audit';
import { benchCommand } from './bench';
import type { Command } from './command';
import { devCommand } from './dev';
import { i18nCommand } from './i18n';
import { infraCommand } from './infra/command';
import { pentestCommand } from './pentest';
import { shootCommand } from './screenshots';
import { statsCommand } from './stats';
import { styleCommand } from './style';
import { testbedCommand } from './testbed';
import { adoptCommand, alignCommand, analyzeCommand, upgradeCommand } from './upstream';

/** Every command, in help and menu order: commander lists a help group where its first command is. */
export const commands: Command[] = [
  devCommand,
  testbedCommand,
  benchCommand,
  a11yCommand,
  shootCommand,
  i18nCommand,
  statsCommand,
  auditCommand,
  pentestCommand,
  infraCommand,
  analyzeCommand,
  upgradeCommand,
  alignCommand,
  adoptCommand,
  styleCommand,
];
