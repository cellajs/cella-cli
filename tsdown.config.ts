import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: {
      index: 'src/cella-cli.ts',
      config: 'src/exports/config.ts',
      bench: 'src/exports/bench.ts',
      style: 'src/exports/style.ts',
      drive: 'src/exports/drive.ts',
      a11y: 'src/exports/a11y.ts',
      screenshots: 'src/exports/screenshots.ts',
      pentest: 'src/exports/pentest.ts',
      infra: 'src/infra/exports.ts',
      'infra-program': 'src/infra/program.ts',
      'infra-contract': 'src/infra/contract.ts',
    },
    // The exports map names .js and .d.ts files
    fixedExtension: false,
    sourcemap: true,
    dts: true,
    // Declarations import playwright and typescript types from the app's own install
    deps: { dts: { neverBundle: true } },
    // An unresolved import only warns, and the bundle then crashes at start
    failOnWarn: true,
    // The engine's build files, which the apply and the builder read beside the bundle (lib/utils/paths.ts)
    copy: [
      { from: 'src/infra/Dockerfile', to: 'dist/infra-assets' },
      { from: ['src/infra/agent/Dockerfile', 'src/infra/agent/docker.asc'], to: 'dist/infra-assets/agent' },
      { from: ['src/infra/caddy/Dockerfile', 'src/infra/caddy/Caddyfile'], to: 'dist/infra-assets/caddy' },
    ],
  },
  {
    // The agent every machine runs: one CommonJS file its image copies, with no dependency to install
    entry: { entry: 'src/infra/agent/src/entry.ts' },
    outDir: 'dist/infra-assets/agent',
    format: 'cjs',
    platform: 'node',
    clean: false,
    dts: false,
    sourcemap: false,
    // The launcher on every machine runs agent.cjs: tsdown's advice to build ESM is a warning here, not a fault
    failOnWarn: false,
  },
]);
