import type { ToolCommand } from '../config/types';
import { pentestCommand } from './pentest';
import { testbedCommand } from './testbed';

/** The develop and security commands, in menu order. */
export const toolCommands: ToolCommand[] = [testbedCommand, pentestCommand];
