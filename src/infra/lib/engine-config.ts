import type { DescribedEngineConfig } from './description/schema';

/**
 * The engine's input contract: the fields of the app's `appConfig` the engine reads (`engineConfigSchema`). A new field the engine reads
 * belongs in that schema first, and in the applied description (lib/deploy/app-description.ts).
 */
export type EngineConfig = DescribedEngineConfig;

/** One service's endpoint entry in the app config (`services.<slug>`). */
export type EngineServiceEndpoint = EngineConfig['services'][string];
