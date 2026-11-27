import { commandTitle } from '../../../utils/display';
import type { OperatorActionId } from '../../lib/operator-actions';
import type { Environment } from '../../lib/stack/environment';
import { crossMark, pc } from '../../lib/utils/cli-output';
import { environmentName } from '../header';

/** The first screen of an action that deletes data, printed before any key or typed confirmation: its title, then what is lost and what is kept. */
export function printLossWarning(action: OperatorActionId, environment: Environment, lines: readonly string[]): void {
  console.info(`\n${commandTitle('infra', action)}${pc.dim(' · ')}${environmentName(environment)}\n`);
  console.info(`${lines.map((line, index) => `${index === 0 ? crossMark : ' '} ${line}`).join('\n')}\n`);
}
