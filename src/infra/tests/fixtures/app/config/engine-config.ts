import { defineEngineConfig, type EngineConfig } from '@cellajs/cli/infra';
import production from './engine-config.production.json' with { type: 'json' };

/** The template's production config as its engine config resolved it: the fixture the engine's tests deploy. */
export const engineConfig: EngineConfig = defineEngineConfig(production);
