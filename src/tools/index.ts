import type { ToolCommand } from '../config/types';
import { benchCommand } from './bench/command';
import { styleCommand } from './style';
import { testbedCommand } from './testbed';

/** The develop, security and gate commands, in menu and help order. */
export const toolCommands: ToolCommand[] = [testbedCommand, benchCommand, styleCommand];
