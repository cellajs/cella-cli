import { describe, expect, it } from 'vitest';
import { rewriteSpecifier } from '../src/utils/audit-utils';
import {
  applyRuntimeUpdate,
  parseDockerfile,
  planRuntimeUpdates,
  type RuntimeFeeds,
  type RuntimePins,
} from '../src/utils/runtimes';

const NOW = Date.parse('2026-10-22T14:00:00Z');
const ago = (hours: number) => NOW - hours * 60 * 60 * 1000;
const iso = (hours: number) => new Date(ago(hours)).toISOString();

describe('runtimes', () => {
  it('reads the Docker Hub tags a Dockerfile builds from, and the suffixes of its Node build-argument images', () => {
    const dockerfile = `ARG NODE_VERSION
FROM node:\${NODE_VERSION}-alpine AS base
FROM base AS build
FROM --platform=linux/amd64 caddy:2.8-alpine
FROM docker.io/library/postgres:17
FROM ghcr.io/owner/tool:1.2
FROM scratch
FROM redis@sha256:0123abcd
FROM bitnami/redis:7.4 AS cache
FROM node:\${NODE_VERSION}-bookworm-slim
FROM \${BASE_IMAGE}
FROM nginx`;

    expect(parseDockerfile('infra/Dockerfile', dockerfile)).toEqual({
      images: [
        { file: 'infra/Dockerfile', line: 3, image: 'caddy', tag: '2.8-alpine' },
        { file: 'infra/Dockerfile', line: 4, image: 'postgres', tag: '17' },
        { file: 'infra/Dockerfile', line: 8, image: 'bitnami/redis', tag: '7.4' },
      ],
      nodeImageSuffixes: ['-alpine', '-bookworm-slim'],
    });
  });

  it('moves a pin only to a version older than the release age, and marks security fixes and frozen tags', () => {
    const pins: RuntimePins = {
      node: '26.12.0',
      pnpm: '11.8.0',
      images: [
        { file: 'infra/caddy/Dockerfile', line: 10, image: 'caddy', tag: '2.8-alpine' },
        { file: 'backend/db/Dockerfile', line: 2, image: 'postgres', tag: '17' },
        { file: 'Dockerfile', line: 0, image: 'nginx', tag: '1.27' },
      ],
      nodeImageSuffixes: ['-alpine'],
    };
    const feeds: RuntimeFeeds = {
      node: [
        { version: '26.13.0', publishedAt: ago(1), security: false },
        { version: '26.12.1', publishedAt: ago(27), security: true },
        { version: '26.12.0', publishedAt: ago(200), security: false },
      ],
      pnpm: {
        published: {
          created: iso(9000),
          '11.11.0': iso(2000),
          '11.28.6': iso(170),
          '11.28.7': iso(1),
          '12.15.0': iso(27),
        },
        advisories: [
          { vulnerable_versions: '>=11.0.0 <11.11.0', severity: 'high' },
          { vulnerable_versions: '>=11.0.0 <12.0.0', severity: 'high' },
        ],
      },
      images: [
        {
          pinned: { name: '2.8-alpine', pushedAt: ago(24 * 400) },
          tags: [
            { name: '2.11-alpine', pushedAt: ago(10) },
            { name: '2.11.7-alpine', pushedAt: ago(10) },
            { name: '2.10-alpine', pushedAt: ago(24 * 100) },
            { name: '3.0-alpine', pushedAt: ago(10) },
            { name: '2.12-builder-alpine', pushedAt: ago(10) },
          ],
        },
        null,
        null,
      ],
    };

    expect(planRuntimeUpdates(pins, feeds, { releaseAgeMinutes: 1440, now: NOW })).toEqual({
      updates: [
        expect.objectContaining({ name: 'node', target: '26.12.1', severity: 'high', note: 'security release' }),
        expect.objectContaining({ name: 'pnpm', target: '11.28.6', severity: 'high', note: '1 advisory' }),
        expect.objectContaining({
          name: 'caddy',
          current: '2.8',
          target: '2.11',
          severity: 'moderate',
          note: 'tag frozen since sep 2025',
          pin: { kind: 'image', line: 10, ref: 'caddy:2.8-alpine', to: 'caddy:2.11-alpine' },
        }),
      ],
      unchecked: ['nginx'],
    });
  });

  it('rewrites specifiers the way pnpm up --latest does, and pins without leaving a stale hash or other lines', () => {
    expect(
      [
        ['^11.2.6', '11.2.7'],
        ['6.0.0', '6.1.0'],
        ['~0.222.0', '0.300.0'],
        ['workspace:*', '1.0.0'],
        ['catalog:', '1.0.0'],
        ['npm:other@^1.0.0', '1.1.0'],
        ['>=1.2.0', '1.3.0'],
        ['1.x', '1.3.0'],
        ['latest', '1.3.0'],
      ].map(([spec, latest]) => rewriteSpecifier(spec, latest)),
    ).toEqual(['^11.2.7', '6.1.0', '~0.300.0', null, null, null, null, null, null]);

    const manifest =
      '{\n  "engines": {\n    "node": "26.12.0"\n  },\n  "packageManager": "pnpm@11.8.0+sha512.abc"\n}\n';
    const pnpm = applyRuntimeUpdate(manifest, {
      name: 'pnpm',
      current: '11.8.0',
      target: '11.28.6',
      file: 'package.json',
      severity: null,
      note: '',
      releasesUrl: '',
      pin: { kind: 'pnpm' },
    });
    expect(pnpm).toBe(manifest.replace('pnpm@11.8.0+sha512.abc', 'pnpm@11.28.6'));

    const dockerfile = '# caddy:2.8-alpine is the proxy\nFROM caddy:2.8-alpine\n';
    const caddy = applyRuntimeUpdate(dockerfile, {
      name: 'caddy',
      current: '2.8',
      target: '2.11',
      file: 'Dockerfile',
      severity: null,
      note: '',
      releasesUrl: '',
      pin: { kind: 'image', line: 1, ref: 'caddy:2.8-alpine', to: 'caddy:2.11-alpine' },
    });
    expect(caddy).toBe('# caddy:2.8-alpine is the proxy\nFROM caddy:2.11-alpine\n');
  });
});
