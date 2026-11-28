import { classTexts, classTokens, splitToken } from './class-strings';
import { type Finding, isFrontendSource, lineColumn, parseSource, type Rule } from './rule';
import { isFrontendStylesheet } from './tailwind-class-rules';

// Divide colour and style utilities draw nothing without a width utility, which this matches
const childSpacing = /^(?:-?space-[xy]-.+|divide-[xy](?:-.+)?)$/;
const enterExit = /^animate-(?:in|out)$/;
const easingStylesheet = 'frontend/src/styling/tailwind.css';
const motionMessage =
  'a state change is a Tailwind transition on its attribute, with timing from the motion presets; an easing curve is a token declared in styling/tailwind.css';

/** The class tokens of one frontend file whose utility, without its variants, matches `utility`. */
function classFindings(rule: string, utility: RegExp, message: string, file: string, source: string): Finding[] {
  return classTexts(parseSource(file, source))
    .flatMap(classTokens)
    .filter(({ token }) => utility.test(splitToken(token).base))
    .map(({ token, offset }) => ({ file, ...lineColumn(source, offset), rule, term: token, message }));
}

/** Space and divide width utilities in the class strings of one frontend file. */
export const childSpacingRule: Rule = {
  id: 'child-spacing',
  reads: isFrontendSource,
  check: (file, source) =>
    /space-|divide-/.test(source)
      ? classFindings(
          'child-spacing',
          childSpacing,
          'compiles to a > :not(:last-child) selector tried on every element; use gap-* on a flex or grid parent, or a border on the child',
          file,
          source,
        )
      : [],
};

/** Enter and exit animation classes in one frontend file, and an easing curve written outside the stylesheet that declares the tokens. */
export const motionTimingRule: Rule = {
  id: 'motion-timing',
  reads: (file) => (isFrontendSource(file) || isFrontendStylesheet(file)) && file !== easingStylesheet,
  check: (file, source) => {
    const curves = [...source.matchAll(/cubic-bezier\(/g)].map(
      ({ index }): Finding => ({ file, ...lineColumn(source, index), rule: 'motion-timing', term: 'cubic-bezier(', message: motionMessage }),
    );
    if (!isFrontendSource(file) || !/animate-(?:in|out)/.test(source)) return curves;
    return [...curves, ...classFindings('motion-timing', enterExit, motionMessage, file, source)];
  },
};
