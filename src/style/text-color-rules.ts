import { classTexts, classTokens, splitToken } from './class-strings';
import { type Finding, isFrontendSource, lineColumn, parseSource, type Rule } from './rule';

const tokenModifier = /^text-[a-z-]*foreground(?:-soft)?\/[\w.[\]]+$/;
const paletteGray = /^text-(?:gray|slate|zinc|neutral|stone)-\d+(?:\/[\w.[\]]+)?$/;

/** Text color findings in the class strings of one frontend file: a modified text token, or a palette gray. */
export const textColorRule: Rule = {
  id: 'text-color',
  reads: isFrontendSource,
  check: (file, source) => {
    if (!/text-/.test(source)) return [];
    const finding = (offset: number, term: string, message: string): Finding => ({
      file,
      ...lineColumn(source, offset),
      rule: 'text-color',
      term,
      message,
    });
    return classTexts(parseSource(file, source))
      .flatMap(classTokens)
      .flatMap(({ token, offset }) => {
        const { variants, base } = splitToken(token);
        if (tokenModifier.test(base) && !variants.some((variant) => variant.includes('disabled'))) {
          return finding(
            offset,
            token,
            'a text token takes no opacity modifier; pick the step: text-foreground-soft, text-muted-foreground or text-faint-foreground',
          );
        }
        if (paletteGray.test(base)) {
          return finding(offset, token, 'a palette gray skips the theme and the contrast setting; use a text step such as text-muted-foreground');
        }
        return [];
      });
  },
};
