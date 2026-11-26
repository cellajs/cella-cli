import { ts } from 'ts-morph';

/** A whitespace-separated token of a string and its offset in the source file. */
type Token = { token: string; offset: number };

/**
 * The variants and the utility of a class token, without the important marker: `md:hover:x!` gives `['md', 'hover']`
 * and `x`. A `:` inside `[]` or `()` belongs to an arbitrary value or variant, as in `has-[a:hover]:x` or `text-[length:1em]`.
 */
export function splitToken(token: string): { variants: string[]; base: string } {
  const text = token.replace(/^!|!$/g, '');
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') depth--;
    else if (char === ':' && depth === 0) {
      variants.push(text.slice(start, index));
      start = index + 1;
    }
  }
  return { variants, base: text.slice(start).replace(/^!/, '') };
}

/** Calls whose arguments are class values; object keys are class names and object values conditions, as in clsx. */
const classFunctions = new Set(['clsx', 'cn', 'cx', 'tw', 'twJoin', 'twMerge']);
const classNamePattern = /^(?:class|classes|className|classNames|classList)$|[a-z](?:Class|Classes|Class[Nn]ames?|ClassList)$/;
type Mode = 'class' | 'clsx';

/** Text of one string or template piece in a class position; `open*` marks a side that touches a `${...}` placeholder. */
interface ClassText {
  /** Offset of `raw` in the source file. */
  start: number;
  /** The value, escapes resolved. */
  text: string;
  /** The source text of the value, which `start` locates. */
  raw: string;
  openStart: boolean;
  openEnd: boolean;
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;
}

function isClassNamed(...names: (string | undefined)[]): boolean {
  return names.some((name) => name !== undefined && classNamePattern.test(name));
}

/** Strings in class positions: class attributes, class helper calls, cva, `tw` templates and class-named values. */
export function classTexts(sourceFile: ts.SourceFile): ClassText[] {
  const texts: ClassText[] = [];
  const add = (node: ts.StringLiteralLike | ts.TemplateLiteralLikeNode, openStart = false, openEnd = false) => {
    const start = node.getStart(sourceFile) + 1;
    const end = node.end - (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1);
    texts.push({ start, text: node.text, raw: sourceFile.text.slice(start, end), openStart, openEnd });
  };
  const addKey = (name: ts.Node) => {
    if (ts.isStringLiteral(name)) add(name);
    else if (ts.isIdentifier(name))
      texts.push({
        start: name.getStart(sourceFile),
        text: name.text,
        raw: name.text,
        openStart: false,
        openEnd: false,
      });
    else walk(name);
  };

  function collectTemplate(node: ts.TemplateExpression): void {
    add(node.head, false, true);
    let before = node.head.text;
    for (const [index, span] of node.templateSpans.entries()) {
      const last = index === node.templateSpans.length - 1;
      // A placeholder holds whole classes only when whitespace or the string edge separates it from the text around it.
      const leftClosed = /\s$/.test(before) || (index === 0 && before === '');
      const rightClosed = /^\s/.test(span.literal.text) || (last && span.literal.text === '');
      if (leftClosed && rightClosed) collect(span.expression, 'class');
      else walk(span.expression);
      add(span.literal, true, !last);
      before = span.literal.text;
    }
  }

  function collectObject(node: ts.ObjectLiteralExpression, mode: Mode): void {
    for (const property of node.properties) {
      if (mode === 'clsx' && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) {
        addKey(property.name);
        if (ts.isPropertyAssignment(property)) walk(property.initializer);
      } else if (ts.isPropertyAssignment(property)) {
        walk(property.name);
        collect(property.initializer, 'class');
      } else walk(property);
    }
  }

  function collectCva(node: ts.CallExpression): void {
    const [base, config, ...rest] = node.arguments;
    collect(base, 'class');
    for (const argument of rest) walk(argument);
    if (!config || !ts.isObjectLiteralExpression(config)) {
      walk(config);
      return;
    }
    for (const property of config.properties) {
      if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== 'variants' || !ts.isObjectLiteralExpression(property.initializer)) {
        walk(property);
        continue;
      }
      for (const variant of property.initializer.properties) {
        if (ts.isPropertyAssignment(variant) && ts.isObjectLiteralExpression(variant.initializer)) collectObject(variant.initializer, 'class');
        else walk(variant);
      }
    }
  }

  function calleeName(node: ts.CallExpression): string | undefined {
    const callee = node.expression;
    return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  }

  /** Whether `node` starts a class position, collecting it when it does. */
  function collectCall(node: ts.CallExpression, mode?: Mode): boolean {
    const name = calleeName(node);
    if (name === 'cva') collectCva(node);
    else if (name && classFunctions.has(name)) {
      walk(node.expression);
      for (const argument of node.arguments) collect(argument, 'clsx');
    } else if (mode && (name === 'join' || name === 'filter') && ts.isPropertyAccessExpression(node.expression)) {
      collect(node.expression.expression, mode);
      for (const argument of node.arguments) walk(argument);
    } else return false;
    return true;
  }

  function collectReturns(node: ts.FunctionLikeDeclaration, mode: Mode): void {
    for (const parameter of node.parameters) walk(parameter);
    if (node.body && !ts.isBlock(node.body)) collect(node.body, mode);
    else walk(node.body, mode);
  }

  function collect(node: ts.Node | undefined, mode: Mode): void {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node);
    else if (ts.isTemplateExpression(node)) collectTemplate(node);
    else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSpreadElement(node) ||
      ts.isJsxExpression(node)
    )
      collect(node.expression, mode);
    else if (ts.isConditionalExpression(node)) {
      walk(node.condition);
      collect(node.whenTrue, mode);
      collect(node.whenFalse, mode);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      walk(node.left);
      collect(node.right, mode);
    } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      collect(node.left, mode);
      collect(node.right, mode);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collect(element, mode);
    } else if (ts.isObjectLiteralExpression(node)) collectObject(node, mode);
    else if (ts.isElementAccessExpression(node)) {
      collect(node.expression, mode);
      walk(node.argumentExpression);
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) collectReturns(node, mode);
    else if (!ts.isCallExpression(node) || !collectCall(node, mode)) walk(node);
  }

  /** Collects `node` when it starts a class position; `returns` is set inside a class-named function. */
  function collectStart(node: ts.Node, returns?: Mode): boolean {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && isClassNamed(node.name.text)) collect(node.initializer, 'class');
    else if (ts.isCallExpression(node)) return collectCall(node);
    else if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'tw') collect(node.template, 'class');
    else if (ts.isReturnStatement(node) && returns) collect(node.expression, returns);
    // Storybook argTypes describe controls (`className: { control: 'text' }`), never classes.
    else if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'argTypes') return true;
    else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) &&
      node.initializer &&
      isClassNamed(propertyName(node.name))
    ) {
      walk(node.name);
      collect(node.initializer, 'class');
    } else if (ts.isBindingElement(node) && node.initializer && isClassNamed(propertyName(node.name), propertyName(node.propertyName))) {
      collect(node.initializer, 'class');
    } else if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && isClassNamed(propertyName(node.name))) {
      collectReturns(node, 'class');
    } else return false;
    return true;
  }

  /** Visits `node` and its children looking for class positions. */
  function walk(node: ts.Node | undefined, returns?: Mode): void {
    if (!node || ts.isTypeNode(node) || collectStart(node, returns)) return;
    const inner = ts.isFunctionLike(node) ? undefined : returns;
    ts.forEachChild(node, (child) => walk(child, inner));
  }

  walk(sourceFile);
  return texts;
}

/** Whole tokens of `text` with their offsets; a token touching an open side is part of a dynamic class and skipped. */
export function classTokens({ start, text, raw, openStart, openEnd }: ClassText): Token[] {
  const result: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const end = match.index + match[0].length;
    if ((openStart && match.index === 0) || (openEnd && end === text.length)) continue;
    result.push({ token: match[0], offset: start + (raw === text ? match.index : Math.max(0, raw.indexOf(match[0]))) });
  }
  return result;
}
