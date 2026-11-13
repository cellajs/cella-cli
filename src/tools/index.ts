import type { ToolCommand } from '../config/types';
import { a11yCommand } from './a11y';
import { benchCommand } from './bench/command';
import { i18nCommand } from './i18n';
import { pentestCommand } from './pentest';
import { shootCommand } from './screenshots';
import { statsCommand } from './stats';
import { styleCommand } from './style';
import { testbedCommand } from './testbed';

/** The develop, security and gate commands, in menu and help order. */
export const toolCommands: ToolCommand[] = [
  testbedCommand,
  benchCommand,
  a11yCommand,
  shootCommand,
  i18nCommand,
  statsCommand,
  pentestCommand,
  styleCommand,
];
