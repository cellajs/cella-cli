import { blankOut, type Finding, lineColumn, type Rule } from './rule';

const disallowedTerm = /fork/gi;
/** The product name as an identifier or wire string; prose may still contrast the template with the app. */
const productNameInLogic = /cella_[a-z0-9]|\bCella[A-Z]|cellajs\.com|_cella-/g;
/** Logic roots the product-name rule covers; tests, config and docs are the template's own voice. */
const logicRoots = ['backend/src/', 'shared/src/', 'frontend/src/'];
/**
 * The app-side marker the cella-upgrade skill puts on intentional app edits: `// fork: <why>`, the css/md forms and a
 * ` * fork: <why>` line inside a JSDoc block. YAML has a `# fork: <why>` line, which elsewhere could be a private field.
 */
const markerComment = /\/\/[ \t]*fork:[^\n]*|\/\*[ \t]*fork:[\s\S]*?\*\/|<!--[ \t]*fork:[\s\S]*?-->|^[ \t]*\*[ \t]*fork:[^\n]*/gim;
/** The YAML marker: a comment starts a line or follows whitespace, and a `#` inside a value is text. */
const yamlMarkerComment = /(^|[ \t])#[ \t]*fork:[^\n]*/gim;
const sourceControlAdvice = 'use template/app terminology';
const productNameAdvice = 'derive it from appConfig or use a neutral name; the product name is not an identifier or wire string';

/** The CLI's source-control term in a file's path and text, outside the fork markers. */
export const sourceControlTermRule: Rule = {
  id: 'source-control-term',
  reads: () => true,
  check: (file, source) => {
    const finding = (term: string) => ({ file, rule: 'source-control-term', term, message: sourceControlAdvice });
    const markers = source.replace(markerComment, blankOut);
    const scanned = /\.ya?ml$/.test(file) ? markers.replace(yamlMarkerComment, blankOut) : markers;
    return [
      ...[...file.matchAll(disallowedTerm)].map((match) => finding(match[0])),
      ...[...scanned.matchAll(disallowedTerm)].map((match) => ({
        ...finding(match[0]),
        ...lineColumn(scanned, match.index),
      })),
    ];
  },
};

/** An identifier, claim or URL carrying the product name: an app derives such names from `appConfig` or picks a neutral one. */
export const productNameRule: Rule = {
  id: 'product-name',
  reads: (file) => logicRoots.some((root) => file.startsWith(root)) && !/\.test\.tsx?$/.test(file),
  check: (file, source) =>
    [...source.matchAll(productNameInLogic)].map(
      (match): Finding => ({
        file,
        ...lineColumn(source, match.index),
        rule: 'product-name',
        term: match[0],
        message: productNameAdvice,
      }),
    ),
};
