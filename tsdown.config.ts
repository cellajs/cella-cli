import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/cella-cli.ts',
    config: 'src/exports/config.ts',
    bench: 'src/exports/bench.ts',
    style: 'src/exports/style.ts',
    drive: 'src/exports/drive.ts',
    a11y: 'src/exports/a11y.ts',
    screenshots: 'src/exports/screenshots.ts',
    pentest: 'src/exports/pentest.ts',
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
