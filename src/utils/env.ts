import process from 'node:process';

/**
 * Centralized environment access for CLI/runtime integration points.
 */
export function getEnv(name: string): string | undefined {
  // biome-ignore lint/style/noProcessEnv: This module centralizes intentional CLI environment access.
  return process.env[name];
}

/** Whether the variable is set at all, even to an empty string. */
export function hasEnv(name: string): boolean {
  // biome-ignore lint/style/noProcessEnv: This module centralizes intentional CLI environment access.
  return name in process.env;
}

/** A mutable copy of the full environment, for passing to child processes. */
export function getEnvSnapshot(): NodeJS.ProcessEnv {
  // biome-ignore lint/style/noProcessEnv: This module centralizes intentional CLI environment access.
  return { ...process.env };
}
