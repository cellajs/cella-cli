/**
 * Public exports of `@cellajs/cli/style`: the type of an app's `shared/config/vocabulary-allowlist.ts`, and the
 * helpers the template's skill scripts read class strings with. `openRepository` comes first.
 */
export { splitToken } from './src/tools/style/class-tokens';
export { lineColumn, openRepository, repoFiles } from './src/tools/style/repo';
export { parseSource } from './src/tools/style/source-comments';
export { classTexts, classTokens, isClassSource, loadTailwindNode } from './src/tools/style/tailwind-class-rules';
export type { VocabularyAllowlist } from './src/tools/style/vocabulary-rules';
