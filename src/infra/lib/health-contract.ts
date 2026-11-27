/** The health contract every deployed service implements: the engine probes `path` and reads the release version from `versionHeader`. */
export const healthContract = {
  /** Path the health endpoint answers on, from the process alone: a machine's agent restarts a container whose checks of it get no answer. */
  path: '/health',
  /** Response header carrying the running release version (the deploy SHA). */
  versionHeader: 'x-app-version',
} as const;
