/**
 * Folder of the values a deploy reads: one container per runtime secret, named by its `secretName`, which the deploy composes into each
 * machine's env file, beside the repository read key and the uploads key's two halves. No machine holds a key that reads it.
 * The folders are the security boundary: an IAM condition grants secret-value reads by `resource.name.startsWith(<path>)`, and where a
 * secret lives decides who reads it. They start at the root of the environment's own project, which each rule names.
 */
export const RUNTIME_FOLDER = '/runtime/';

/** Folder for engine-internal keys: the deploy key's copy and the database passwords. Only the operator reads it. */
export const ENGINE_FOLDER = '/engine/';

/** The deploy key's condition on secret values: the runtime folder, and nothing else. The identity plan compares the live rule with this string. */
export const runtimeFolderCondition = `resource.name.startsWith("${RUNTIME_FOLDER}")`;
