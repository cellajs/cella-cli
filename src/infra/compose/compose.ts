import { appServices, processIdentityEnv } from '../lib/description';
import { assembleCompose } from './infrastructure';
import type { ServiceMeta } from './types';

/** The full Compose model: machinery + app services. The task `compose` prints it (`synth.ts`). */
export const composeConfig = assembleCompose(appServices, { processIdentityEnv });

/** A service's slug: a key of the description's `services`. */
export type ServiceName = string;

/** Ordered logical-service metadata, derived from the assembled Compose model. */
export const services: readonly ServiceMeta[] = Object.values(composeConfig.services)
  .map((svc) => svc['x-service'])
  .filter((meta): meta is ServiceMeta => meta !== undefined);
