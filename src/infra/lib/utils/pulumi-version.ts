import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import semver from 'semver';

/** The `@pulumi/pulumi` SDK version the program is written against. The main job installs the CLI at exactly this version. */
export function sdkPulumiVersion(): string {
  return (createRequire(import.meta.url)('@pulumi/pulumi/package.json') as { version: string }).version;
}

/** The version in a `pulumi version` output (`v3.253.0` → `3.253.0`), or undefined when it holds none. */
export function parsePulumiVersion(output: string | undefined): string | undefined {
  return output?.match(/v?(\d+\.\d+\.\d+)/)?.[1];
}

/** The installed CLI's version, or undefined when `pulumi` is missing. */
export function installedPulumiVersion(): string | undefined {
  const res = spawnSync('pulumi', ['version'], { encoding: 'utf8' });
  return res.status === 0 ? parsePulumiVersion(res.stdout) : undefined;
}

/** The warning for a local CLI that trails the SDK, or undefined when it is current or absent (absence is reported elsewhere). */
export function pulumiCliLagWarning(installed: string | undefined, sdk: string): string | undefined {
  if (!installed || !semver.lt(installed, sdk)) return undefined;
  return `pulumi ${installed} is older than the @pulumi/pulumi SDK ${sdk} this program uses, and CI runs ${sdk}: upgrade with brew upgrade pulumi.`;
}
