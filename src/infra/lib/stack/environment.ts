/** Every environment a stack can be set up for. */
export const environments = ['production', 'staging'] as const;

export type Environment = (typeof environments)[number];

/** Whether a mode is one of the environments a stack can be set up for. */
export function isEnvironment(mode: string): mode is Environment {
  return environments.some((environment) => environment === mode);
}
