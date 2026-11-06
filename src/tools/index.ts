import type { ToolCommand } from '../config/types';
import { i18nCommand } from './i18n';
import { testbedCommand } from './testbed';

/** The develop and security commands, in menu order. */
export const toolCommands: ToolCommand[] = [testbedCommand, i18nCommand];
