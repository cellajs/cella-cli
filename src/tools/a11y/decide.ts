import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { printStep } from '../../utils/display';
import { parseDecision, recordDecisions } from './ledger';

/** One decision from flags, or a file that holds a list of `{ id, status, by, remarks?, evidence, where? }`. */
export interface DecideOptions {
  file?: string;
  decision: Record<string, unknown>;
}

/**
 * Records reviewers' decisions on criteria the audit leaves open. Nothing is written unless every decision is valid.
 * @throws when the file holds no list, or a decision is incomplete or contradicts the audit's evidence
 */
export function runDecide(forkPath: string, { file, decision }: DecideOptions): number {
  const input: unknown = file ? JSON.parse(readFileSync(resolve(file), 'utf8')) : [decision];
  if (!Array.isArray(input)) throw new Error(`${file} holds no list of decisions`);
  const decisions = input.map(parseDecision);
  const ledger = recordDecisions(forkPath, decisions);
  const count = (by: string) => ledger.criteria.filter((row) => row.decidedBy === by).length;
  printStep(
    'recorded',
    `${decisions.length}; decided by the audit ${count('audit')}, by an agent ${count('agent')}, by a person ${count('human')}`,
  );
  return 0;
}
