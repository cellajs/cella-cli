/**
 * Text from outside the checkout (a commit subject, a pull request title, a machine's boot account) as a terminal can print it:
 * without the control characters that move the cursor, recolor a line or rewrite one already shown, and without the
 * bidirectional controls that show text in another order than it holds. Tab and line feed stay.
 */
export function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: dropping control characters is the purpose
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
