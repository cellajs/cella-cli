import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/cella-cli.ts',
    config: 'config.ts',
    bench: 'src/tools/bench/index.ts',
    style: 'style.ts',
    drive: 'src/tools/drive.ts',
    a11y: 'src/tools/a11y/exports.ts',
    screenshots: 'src/tools/screenshots/exports.ts',
    pentest: 'src/tools/pentest/adapter.ts',
  },
  // The exports map names .js and .d.ts files
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  // Declarations import playwright and typescript types from the app's own install
  deps: { dts: { neverBundle: true } },
  // An unresolved import only warns, and the bundle then crashes at start
  failOnWarn: true,
});
