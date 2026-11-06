import type { ToolCommand } from '../config/types';
import { benchCommand } from './bench/command';
import { testbedCommand } from './testbed';

/** The develop and security commands, in menu order. */
export const toolCommands: ToolCommand[] = [testbedCommand, benchCommand];
