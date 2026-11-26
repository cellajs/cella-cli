import { createPrompt, isEnterKey, isTabKey, makeTheme, type Status, useKeypress, usePrefix, useState } from '@inquirer/core';

/** The answer a y/n line gives: empty takes the default, and undefined is no answer. */
function yesOrNo(line: string, fallback: boolean): boolean | undefined {
  const value = line.trim().toLowerCase();
  if (value === '') return fallback;
  if ('yes'.startsWith(value)) return true;
  if ('no'.startsWith(value)) return false;
  return undefined;
}

/** A prompt as Inquirer runs it: the context carries the abort signal and whether the prompt erases itself once answered. */
type Prompt<Value, Config> = (config: Config, context?: { signal?: AbortSignal; clearPromptOnDone?: boolean }) => Promise<Value>;

interface ConfirmPromptConfig {
  message: string;
  default: boolean;
}

/** A yes/no question: Enter on an empty line takes the default, and no key answers the other one. */
export const confirm: Prompt<boolean, ConfirmPromptConfig> = createPrompt<boolean, ConfirmPromptConfig>((config, done) => {
  const theme = makeTheme();
  const [status, setStatus] = useState<Status>('idle');
  const [value, setValue] = useState('');
  const [errorMsg, setError] = useState<string>();
  const prefix = usePrefix({ status, theme });

  useKeypress((key, rl) => {
    if (status !== 'idle') return;
    if (isEnterKey(key)) {
      const answer = yesOrNo(value, config.default);
      if (answer === undefined) {
        rl.write(value);
        setError('Answer y or n.');
        return;
      }
      setValue(answer ? 'Yes' : 'No');
      setStatus('done');
      done(answer);
    } else {
      setValue(rl.line);
      setError(undefined);
    }
  });

  const message = theme.style.message(config.message, status);
  if (status === 'done') return `${prefix} ${message} ${theme.style.answer(value)}`;
  return [`${prefix} ${message} ${theme.style.defaultAnswer(config.default ? 'Y/n' : 'y/N')} ${value}`, errorMsg ? theme.style.error(errorMsg) : ''];
});

export interface InputPromptConfig {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}

/** A line of text: Tab on an empty line fills the default, and the default stays until something is typed. */
export const input: Prompt<string, InputPromptConfig> = createPrompt<string, InputPromptConfig>((config, done) => {
  const theme = makeTheme();
  const [status, setStatus] = useState<Status>('idle');
  const [value, setValue] = useState('');
  const [errorMsg, setError] = useState<string>();
  const prefix = usePrefix({ status, theme });

  useKeypress(async (key, rl) => {
    if (status !== 'idle') return;
    if (isEnterKey(key)) {
      const answer = value || config.default || '';
      setStatus('loading');
      const valid = config.validate ? await config.validate(answer) : true;
      if (valid === true) {
        setValue(answer);
        setStatus('done');
        done(answer);
        return;
      }
      rl.write(value);
      setError(typeof valid === 'string' ? valid : 'Enter a valid value.');
      setStatus('idle');
    } else if (isTabKey(key) && !value && config.default) {
      rl.clearLine(0);
      rl.write(config.default);
      setValue(config.default);
    } else {
      setValue(rl.line);
      setError(undefined);
    }
  });

  const message = theme.style.message(config.message, status);
  if (status === 'done') return `${prefix} ${message} ${theme.style.answer(value)}`;
  const shownDefault = config.default && !value ? theme.style.defaultAnswer(config.default) : undefined;
  return [[prefix, message, shownDefault, value].filter((part) => part !== undefined).join(' '), errorMsg ? theme.style.error(errorMsg) : ''];
});
