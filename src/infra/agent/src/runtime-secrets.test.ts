import { describe, expect, it } from 'vitest';
import { envFileValues } from './runtime-secrets';

describe('envFileValues', () => {
  it('learns every value of the env file once, an equals sign inside a value included', () => {
    expect(envFileValues('A=one\nB=postgres://u:p@h/db?x=1\nC=one\n\n')).toEqual(['one', 'postgres://u:p@h/db?x=1']);
  });

  it('learns the raw value of a single-quoted line, the form the deploy writes, for the redactor to find', () => {
    expect(envFileValues("A='Kd8$Fh2kLm9xq'\nB=plain\n")).toEqual(['Kd8$Fh2kLm9xq', 'plain']);
  });
});
