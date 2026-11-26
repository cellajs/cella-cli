import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ts } from 'ts-morph';
import { type Finding, isFrontendSource, lineColumn, parseSource, type Rule, type StyleRun } from './rule';

type Report = (node: ts.Node, message: string) => void;

function containsJsx(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node) || !!ts.forEachChild(node, containsJsx);
}

/** The import declarations of a file by module, each with the names it imports: `imported` as exported, `element` the binding. */
function importsOf(sourceFile: ts.SourceFile) {
  return sourceFile.statements.filter(ts.isImportDeclaration).flatMap((declaration) => {
    if (!ts.isStringLiteral(declaration.moduleSpecifier)) return [];
    const bindings = declaration.importClause?.namedBindings;
    const elements = bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
    const names = elements.map((element) => ({ imported: (element.propertyName ?? element.name).text, element }));
    return [{ module: declaration.moduleSpecifier.text, declaration, names }];
  });
}

/** A component is a named function declaration, and a helper such as `memo` wraps a function expression of its name. */
function checkVariableStatement(node: ts.VariableStatement, report: Report): void {
  for (const declaration of node.declarationList.declarations) {
    const name = ts.isIdentifier(declaration.name) ? declaration.name.text : null;
    const initializer = declaration.initializer;
    if (!name || !/^[A-Z]/.test(name) || !initializer || !containsJsx(initializer)) continue;

    if (ts.isArrowFunction(initializer)) {
      report(declaration, `${name} is an ordinary component; use a named function declaration`);
      continue;
    }

    if (!ts.isCallExpression(initializer)) continue;
    const wrappedRender = initializer.arguments.find(
      (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
        (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) && containsJsx(argument),
    );
    if (!wrappedRender || (ts.isFunctionExpression(wrappedRender) && wrappedRender.name?.text === name)) continue;
    report(wrappedRender, `${name} is wrapped by a component helper; use a named function expression`);
  }
}

/** Adds the stores `sourceFile` declares with zustand's `create` to `stores`. */
function collectStores(sourceFile: ts.SourceFile, stores: Set<string>): void {
  const createNames = new Set(
    importsOf(sourceFile)
      .filter(({ module }) => module === 'zustand')
      .flatMap(({ names }) => names.filter(({ imported }) => imported === 'create').map(({ element }) => element.name.text)),
  );
  if (createNames.size === 0) return;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      let callee: ts.Node | undefined = declaration.initializer;
      while (callee && ts.isCallExpression(callee)) callee = callee.expression;
      if (!callee || !ts.isIdentifier(callee) || !createNames.has(callee.text)) continue;
      if (ts.isIdentifier(declaration.name)) stores.add(declaration.name.text);
    }
  }
}

/** A store is read through a selector: called with no argument, it renders the component again on every field change. */
function checkStoreSelector(node: ts.Node, report: Report, _sourceFile: ts.SourceFile, { stores }: StyleRun): void {
  if (!ts.isCallExpression(node) || node.arguments.length > 0 || !ts.isIdentifier(node.expression)) return;
  const name = node.expression.text;
  if (!stores.has(name)) return;
  report(node, `${name}() subscribes to every field; select the values this component reads`);
}

/**
 * Route context is rebuilt on every navigation, search-only ones included, so a component that reads it whole renders
 * again on each one. `select` narrows the read to a value that stays equal between navigations.
 */
function checkRouteContextSelector(node: ts.Node, report: Report, sourceFile: ts.SourceFile): void {
  if (!ts.isCallExpression(node)) return;
  const callee = node.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
  if (name !== 'useRouteContext') return;
  const [options] = node.arguments;
  // Options passed by name or spread have their `select` elsewhere
  if (options && (!ts.isObjectLiteralExpression(options) || options.properties.some(ts.isSpreadAssignment))) return;
  if (options?.properties.some((property) => property.name?.getText(sourceFile) === 'select')) return;
  report(node, 'useRouteContext() renders again on every navigation; pass `select` and return the id or flag this component reads');
}

/**
 * A Button's press nudge is a `transform` (`active:press`). `active:translate-y-0` sets `translate`, another property,
 * so it compiles and leaves the nudge in place; `press={false}` turns the nudge off.
 */
function checkButtonPressCancel(node: ts.Node, report: Report, sourceFile: ts.SourceFile): void {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
  if (node.tagName.getText(sourceFile) !== 'Button') return;
  for (const attribute of node.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText(sourceFile) !== 'className' || !attribute.initializer) continue;
    if (!/(?<![\w-])!?active:translate-y-0!?(?![\w-])/.test(attribute.initializer.getText(sourceFile))) continue;
    report(attribute, 'active:translate-y-0 does not cancel the press nudge, which is a transform; pass press={false} to the Button');
  }
}

/**
 * A form react-hook-form validates shows why a field is refused under that field. Without `noValidate` the browser
 * refuses an email or web address first, in a bubble of its own and in the browser's language.
 */
function checkFormNoValidate(node: ts.Node, report: Report, sourceFile: ts.SourceFile): void {
  if ((!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) || node.tagName.getText(sourceFile) !== 'form') return;
  const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
  const onSubmit = attributes.find((attribute) => attribute.name.getText(sourceFile) === 'onSubmit');
  if (!onSubmit?.initializer?.getText(sourceFile).includes('handleSubmit(')) return;
  if (attributes.some((attribute) => attribute.name.getText(sourceFile) === 'noValidate')) return;
  report(node, 'a form react-hook-form validates takes noValidate, so its fields say what is wrong, not the browser');
}

/**
 * A drag grip renders through `ReorderHandle` or `reorderColumn`, which give it the arrow keys and the move menu. A drag
 * preview (`*-preview.tsx`) only pictures the grip.
 */
function checkReorderGrip(sourceFile: ts.SourceFile, report: Report): void {
  let grip: ts.Node | undefined;
  let hasHandle = false;
  for (const { module, names } of importsOf(sourceFile)) {
    for (const { imported, element } of names) {
      if (module === 'lucide-react' && /^Grip(?:Vertical|Horizontal)?Icon$/.test(imported)) grip = element;
      if (imported === 'ReorderHandle' || imported === 'reorderColumn') hasHandle = true;
    }
  }
  if (grip && !hasHandle) {
    report(grip, 'render a drag grip through ReorderHandle or reorderColumn, so the keyboard and a pointer that cannot drag move it too');
  }
}

/**
 * A memo whose dependency array names a value its callback never reads. The React Compiler memoizes on what the callback
 * reads, so that value stops triggering a recompute and the result goes stale; derive the result from the value itself.
 */
function checkMemoDependencies(node: ts.Node, report: Report): void {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
  if (node.expression.text !== 'useMemo' && node.expression.text !== 'useCallback') return;
  const [callback, dependencies] = node.arguments;
  if (!callback || !dependencies || !ts.isArrayLiteralExpression(dependencies)) return;
  // A callback passed by name has its body elsewhere
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;

  const read = new Set<string>();
  callback.forEachChild(function collect(child) {
    if (ts.isIdentifier(child)) read.add(child.text);
    child.forEachChild(collect);
  });
  for (const dependency of dependencies.elements) {
    let root: ts.Expression = dependency;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isNonNullExpression(root) || ts.isCallExpression(root)) {
      root = root.expression;
    }
    if (!ts.isIdentifier(root) || read.has(root.text)) continue;
    report(
      dependency,
      `${root.text} is a dependency the callback never reads, so the compiled memo ignores it; read it or derive the result from it`,
    );
  }
}

/** The cache calls that clear a query's refetch mark, each with the helper in `~/query/basic/cache-mutations` that keeps it. */
const markKeepers: Record<string, string> = {
  setQueryData: 'writeKeepingMark',
  setQueriesData: 'writeKeepingMark',
  cancelQueries: 'cancelKeepingMark',
};

/** The calls in `sourceFile` that clear a refetch mark, and whether it registers a range fetch, which only a synced product does. */
function markCalls(sourceFile: ts.SourceFile) {
  const calls: Array<{ node: ts.CallExpression; name: string }> = [];
  let registersRangeFetch = false;
  sourceFile.forEachChild(function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      if (Object.hasOwn(markKeepers, name)) calls.push({ node, name });
      registersRangeFetch ||= name === 'registerEntityQueryKeys' && node.arguments.length > 2;
    }
    node.forEachChild(visit);
  });
  return { calls, registersRangeFetch };
}

/** Keyed by the `query.ts` path, absolute, so a process that checks two repositories reads each one's. */
const productModuleFolders = new Map<string, boolean>();

/** Whether `file` lies in a module folder whose `query.ts` registers a range fetch. */
function inProductModule(root: string, file: string): boolean {
  const folder = /^frontend\/src\/modules\/[^/]+\//.exec(file)?.[0];
  if (!folder) return false;
  const queryFile = join(root, `${folder}query.ts`);
  if (!productModuleFolders.has(queryFile)) {
    const source = existsSync(queryFile) ? readFileSync(queryFile, 'utf8') : '';
    productModuleFolders.set(queryFile, markCalls(ts.createSourceFile(queryFile, source, ts.ScriptTarget.Latest)).registersRangeFetch);
  }
  return productModuleFolders.get(queryFile) === true;
}

/** Query code and the module of a synced product write and cancel through the helpers that keep a query's refetch mark. */
function checkProductCacheWrite(sourceFile: ts.SourceFile, report: Report, { root }: StyleRun): void {
  const file = sourceFile.fileName;
  const { calls, registersRangeFetch } = markCalls(sourceFile);
  if (!calls.length || !(file.startsWith('frontend/src/query/') || registersRangeFetch || inProductModule(root, file))) return;
  for (const { node, name } of calls) {
    report(node, `${name} clears the refetch mark; call ${markKeepers[name]} from ~/query/basic/cache-mutations`);
  }
}

/** The zustand stores the frontend creates, read from every frontend file so a path-limited run still knows them. */
export function frontendStores(root: string, files: string[]): Set<string> {
  const stores = new Set<string>();
  for (const file of files.filter(isFrontendSource)) {
    const source = readFileSync(join(root, file), 'utf8');
    if (source.includes('zustand')) collectStores(parseSource(file, source), stores);
  }
  return stores;
}

/** A rule whose `inspect` reports nodes of a frontend file's parse. */
function frontendRule(
  id: string,
  inspect: (sourceFile: ts.SourceFile, report: Report, run: StyleRun) => void,
  reads: (file: string) => boolean = isFrontendSource,
): Rule {
  return {
    id,
    reads,
    check: (file, source, run) => {
      const sourceFile = parseSource(file, source);
      const findings: Finding[] = [];
      const report: Report = (node, message) => findings.push({ file, ...lineColumn(source, node.getStart(sourceFile)), rule: id, message });
      inspect(sourceFile, report, run);
      return findings;
    },
  };
}

/** A frontend rule that judges every node of the file's parse. */
function nodeRule(id: string, visit: (node: ts.Node, report: Report, sourceFile: ts.SourceFile, run: StyleRun) => void): Rule {
  return frontendRule(id, (sourceFile, report, run) =>
    sourceFile.forEachChild(function walk(node) {
      visit(node, report, sourceFile, run);
      node.forEachChild(walk);
    }),
  );
}

/** The convention rules of frontend code. */
export const frontendRules: Rule[] = [
  frontendRule(
    'component-declaration',
    (sourceFile, report) => {
      for (const statement of sourceFile.statements.filter(ts.isVariableStatement)) checkVariableStatement(statement, report);
    },
    (file) => isFrontendSource(file) && file.endsWith('.tsx'),
  ),
  frontendRule('reorder-grip', checkReorderGrip, (file) => isFrontendSource(file) && !file.endsWith('-preview.tsx')),
  // The helpers that keep the mark write through the plain calls
  frontendRule(
    'product-cache-write',
    checkProductCacheWrite,
    (file) => isFrontendSource(file) && file !== 'frontend/src/query/basic/cache-mutations.ts',
  ),
  nodeRule('store-selector', checkStoreSelector),
  nodeRule('route-context-selector', checkRouteContextSelector),
  nodeRule('button-press-cancel', checkButtonPressCancel),
  nodeRule('form-no-validate', checkFormNoValidate),
  nodeRule('memo-dependency-unread', checkMemoDependencies),
];
