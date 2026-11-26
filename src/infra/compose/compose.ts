import { appServices, processIdentityEnv } from 'infra/config/services.config';
import { assembleCompose } from './infrastructure';
import type { ServiceMeta } from './types';

/** The full Compose model: machinery + app services. Emitted by `synth.ts`. */
export const composeConfig = assembleCompose(appServices, { processIdentityEnv });

/** The literal service-name union, derived from the app's service registry. */
export type ServiceName = keyof typeof appServices;

/** Ordered logical-service metadata, derived from the assembled Compose model. */
export const services: readonly ServiceMeta[] = Object.values(composeConfig.services)
  .map((svc) => svc['x-service'])
  .filter((meta): meta is ServiceMeta => meta !== undefined);
