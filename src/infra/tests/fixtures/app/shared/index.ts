import production from './app-config.production.json' with { type: 'json' };

const snapshots = { production };

const isSnapshotMode = (mode: string): mode is keyof typeof snapshots => Object.hasOwn(snapshots, mode);

const mode = process.env.APP_MODE || 'production';
if (!isSnapshotMode(mode)) throw new Error(`fixture app: no appConfig snapshot for APP_MODE '${mode}'`);

/** The template's config as it resolved for `APP_MODE`, which defaults to production: the one mode the fixture holds. */
export const appConfig = snapshots[mode];
