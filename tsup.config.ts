import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/cella-cli.ts', config: 'config.ts' },
  outDir: 'dist',
  clean: true,
  minify: false,
  format: ['esm'],
  target: 'esnext',
  splitting: false,
  sourcemap: true,
  dts: true,
  esbuildOptions(options) {
    options.alias = {
      '#': resolve(__dirname, './src'),
    };
    options.platform = 'node';
    options.mainFields = ['module', 'main'];
    options.conditions = ['module'];
  },
  external: ['@inquirer/core', '@inquirer/prompts', '@pierre/diffs', 'commander', 'ts-morph', 'zod'],
});
