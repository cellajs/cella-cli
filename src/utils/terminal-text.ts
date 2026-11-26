/**
 * Text from outside the checkout (a commit subject, a pull request title, a machine's boot account) as a terminal can print it:
 * without the control characters that move the cursor, recolor a line or rewrite one already shown. Tab and line feed stay.
 */
export function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: dropping control characters is the purpose
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
