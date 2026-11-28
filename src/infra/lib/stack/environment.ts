/** Every environment the CLI can install. */
export const environments = ['production', 'staging'] as const;

export type Environment = (typeof environments)[number];

/** Whether a mode is one of the environments the CLI can install. */
export function isEnvironment(mode: string): mode is Environment {
  return environments.some((environment) => environment === mode);
}
