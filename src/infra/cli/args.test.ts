import { describe, expect, it } from 'vitest';
import { parseCliArgs, splitFlagValues } from './args';

describe('parseCliArgs', () => {
  it('opens the menu when no action is named', () => {
    expect(parseCliArgs([])).toEqual({ once: false, help: false });
    expect(parseCliArgs(['--mode', 'staging'])).toEqual({ once: false, help: false, mode: 'staging' });
  });

  it('reads the first word as the action', () => {
    expect(parseCliArgs(['status'])).toMatchObject({ action: 'status' });
    expect(parseCliArgs(['db-close', '--mode', 'production'])).toMatchObject({ action: 'db-close', mode: 'production' });
  });

  it('never reads the value of --mode as the action', () => {
    expect(parseCliArgs(['--mode', 'production', 'apply'])).toMatchObject({ action: 'apply', mode: 'production' });
    expect(parseCliArgs(['--mode', 'status'])).toEqual({ once: false, help: false, mode: 'status' });
  });

  it('reports a word that names no action', () => {
    expect(parseCliArgs(['runs'])).toMatchObject({ unknownAction: 'runs' });
    expect(parseCliArgs(['runs']).action).toBeUndefined();
  });

  it('reads --once and the help forms', () => {
    expect(parseCliArgs(['--once'])).toMatchObject({ once: true });
    expect(parseCliArgs(['help'])).toMatchObject({ help: true });
    expect(parseCliArgs(['--help'])).toMatchObject({ help: true });
    expect(parseCliArgs(['-h', 'apply'])).toMatchObject({ help: true, action: 'apply' });
  });

  it('lets the flags the actions read pass through', () => {
    expect(parseCliArgs(['apply', '--debug-provider', '--defaults'])).toEqual({ once: false, help: false, action: 'apply' });
  });

  it('reads --flag=value as --flag value', () => {
    expect(parseCliArgs(['apply', '--mode=staging'])).toEqual({ once: false, help: false, action: 'apply', mode: 'staging' });
    expect(splitFlagValues(['logs', '--sha=abc1234'])).toEqual(['logs', '--sha', 'abc1234']);
  });

  it('refuses an unknown flag', () => {
    expect(parseCliArgs(['apply', '--mode=staging', '--yes']).refusal).toBe("unknown option '--yes' for infra apply");
  });

  it('refuses a flag without its value', () => {
    expect(parseCliArgs(['logs', '--sha']).refusal).toBe("option '--sha' needs a value");
  });

  it('refuses a second word', () => {
    expect(parseCliArgs(['status', 'staging']).refusal).toBe("unexpected word 'staging' after infra status");
  });

  it('refuses a mode named twice: the run would take one of the two without a word', () => {
    expect(parseCliArgs(['apply', '--mode', 'staging', '--mode', 'production']).refusal).toBe("option '--mode' is given twice");
  });

  it('refuses a flag on an action that never reads it, and takes it with the menu', () => {
    expect(parseCliArgs(['deploy-now', '--sha', 'abc1234']).refusal).toBe("option '--sha' belongs to infra logs, not to infra deploy-now");
    expect(parseCliArgs(['--sha', 'abc1234']).refusal).toBeUndefined();
  });
});
