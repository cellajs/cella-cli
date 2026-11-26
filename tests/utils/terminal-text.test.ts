import { describe, expect, it } from 'vitest';
import { printable } from '../../src/utils/terminal-text';

describe('printable', () => {
  it('drops an escape sequence that writes the clipboard, and keeps tab and line feed', () => {
    expect(printable('ok\t1\n\x1b]52;c;Y3VybCBldmlsIHwgc2g=\x07done\x9b2J')).toBe(
      'ok\t1\n]52;c;Y3VybCBldmlsIHwgc2g=done2J',
    );
  });
});
