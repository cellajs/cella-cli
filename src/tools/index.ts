import type { ToolCommand } from '../config/types';
import { a11yCommand } from './a11y';
import { benchCommand } from './bench/command';
import { screenshotsCommand } from './screenshots';
import { styleCommand } from './style';
import { testbedCommand } from './testbed';

/** The develop, security and gate commands, in menu and help order. */
export const toolCommands: ToolCommand[] = [
  testbedCommand,
  benchCommand,
  a11yCommand,
  screenshotsCommand,
  styleCommand,
];
