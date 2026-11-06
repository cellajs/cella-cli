import type { ToolCommand } from '../config/types';
import { a11yCommand } from './a11y';
import { screenshotsCommand } from './screenshots';
import { testbedCommand } from './testbed';

/** The develop and security commands, in menu order. */
export const toolCommands: ToolCommand[] = [testbedCommand, a11yCommand, screenshotsCommand];
