import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveInfra } from '../../lib/naming';
import { securityHeaders } from '../../tasks/smoke';
import { fakeConfig } from '../helpers/fake-config';

const caddyDir = join(import.meta.dirname, '../../caddy');
const caddyfile = readFileSync(join(caddyDir, 'Caddyfile'), 'utf-8');
const dockerfile = readFileSync(join(caddyDir, 'Dockerfile'), 'utf-8');

// The negative assertion below checks that no bucket is hardcoded, whatever the slug: the name comes from the fixture.
const frontendBucket = deriveInfra(fakeConfig()).naming.frontendBucket;

/** The value the global header block sets for a response header, or undefined when the block does not set it. */
const headerValue = (name: string): string | undefined => caddyfile.match(new RegExp(`^\\s*${name}\\s+"([^"]*)"`, 'm'))?.[1];

// Pins the Caddyfile contract the agent's check and the smoke tests depend on.
describe('frontend Caddyfile', () => {
  it('sets every header the deploy smoke check requires, with the values that lock the response down', () => {
    // Names only would pass a header emptied or weakened; the smoke check verifies presence on the live deployment, so the values are pinned here.
    for (const header of securityHeaders) expect(headerValue(header), header).toBeTruthy();
    const hsts = headerValue('Strict-Transport-Security') ?? '';
    expect(Number(hsts.match(/max-age=(\d+)/)?.[1])).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).toContain('preload');
    expect(headerValue('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff');
    expect(headerValue('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headerValue('Permissions-Policy')).toBe('{$FRONTEND_PERMISSIONS_POLICY}');
  });

  it('strips the Server header so the upstream is not advertised', () => {
    expect(caddyfile).toMatch(/-Server\b/);
  });

  it('exposes X-App-Version bound to {$RELEASE_SHA} env', () => {
    // The agent passes the check only when X-App-Version is the machine's release; breaking it fails every switch at its serving wait.
    expect(caddyfile).toMatch(/X-App-Version\s+"\{\$RELEASE_SHA\}"/);
  });

  it('binds CSP from the {$FRONTEND_CSP} env', () => {
    expect(headerValue('Content-Security-Policy')).toBe('{$FRONTEND_CSP}');
  });

  // The embedded pages show inside an LTI platform's frame: only theirs may carry another framing policy.
  it('gives a page under /embed/ the {$FRONTEND_EMBED_CSP} env and no X-Frame-Options, every other response both of its own', () => {
    expect(caddyfile).toMatch(
      /@framedByApp not path \/embed\/\*\s*\n\s*header @framedByApp \{\s*\n\s*Content-Security-Policy "\{\$FRONTEND_CSP\}"\s*\n\s*X-Frame-Options "SAMEORIGIN"/,
    );
    expect(caddyfile).toMatch(/@embedded path \/embed\/\*\s*\n\s*header @embedded Content-Security-Policy "\{\$FRONTEND_EMBED_CSP\}"/);
    expect(caddyfile.match(/X-Frame-Options "/g)).toHaveLength(1);
  });

  it("serves /health locally (the agent's check depends on it)", () => {
    expect(caddyfile).toMatch(/handle\s+\/health\s*\{/);
    expect(caddyfile).toMatch(/respond\s+"ok"\s+200/);
  });

  it('rewrites 404 from origin to /index.html for SPA deep links', () => {
    expect(caddyfile).toMatch(/handle_response\s+@notfound/);
    expect(caddyfile).toMatch(/rewrite\s+\*\s+\/index\.html/);
    expect(caddyfile).toMatch(/@notfound\s+status\s+404/);
  });

  it('long-caches content-hashed /assets/* only', () => {
    expect(caddyfile).toMatch(/@assets\s+path\s+\/assets\/\*\s*\n/);
    // `>` defers the header, which replaces the Cache-Control S3 returns. Without it the response carries the field twice.
    expect(caddyfile).toMatch(/header >Cache-Control\s+"public,\s*max-age=31536000,\s*immutable"/);
  });

  it('short-caches stable-named /static/* (docs.gen etc. change per release)', () => {
    // Marking /static/* immutable froze docs data in browser caches for a year.
    expect(caddyfile).toMatch(/@static\s+path\s+\/static\/\*/);
    expect(caddyfile).toMatch(/@static\s+path[^{]*\{\s*\n\s*header >Cache-Control "public, max-age=3600"/);
  });

  it('reverse-proxies to the {$ORIGIN_HOST} env, not a hardcoded bucket', () => {
    // A hardcoded host would couple the image to one app's bucket name.
    expect(caddyfile).toContain('{$ORIGIN_HOST}');
    expect(caddyfile).not.toContain(`${frontendBucket}.s3.`);
  });

  it('listens on port 80 (matches LB backend.forwardPort)', () => {
    expect(caddyfile).toMatch(/^:80\s*\{/m);
  });

  it('disables auto_https since the LB terminates TLS', () => {
    expect(caddyfile).toMatch(/auto_https\s+off/);
  });

  it("serves the build's brotli copies, and the original when a release before them has none", () => {
    // Without the fallback, a tab still running an older release could no longer load its lazy chunks.
    expect(caddyfile).toMatch(/rewrite\s+\*\s+\{path\}\.br/);
    expect(caddyfile).toMatch(/header_down\s+Content-Encoding\s+br/);
    expect(caddyfile).toMatch(/handle_response\s+@nocopy\s*\{\s*\n\s*rewrite\s+\*\s+\{http\.request\.orig_uri\.path\}/);
  });
});

describe('frontend Caddy Dockerfile', () => {
  it('bakes RELEASE_SHA in via ARG + ENV so X-App-Version survives image start', () => {
    expect(dockerfile).toMatch(/ARG\s+RELEASE_SHA/);
    expect(dockerfile).toMatch(/ENV\s+RELEASE_SHA=\$\{RELEASE_SHA\}/);
  });

  it('copies the Caddyfile beside it into the image', () => {
    expect(dockerfile).toMatch(/COPY\s+Caddyfile\s+\/etc\/caddy\/Caddyfile/);
  });

  it('pins a minor version of the upstream caddy image', () => {
    // `caddy:latest` rebuilds the image whenever upstream tags move: pin a real version and update it deliberately.
    expect(dockerfile).toMatch(/^FROM\s+caddy:2\.\d+/m);
  });
});
