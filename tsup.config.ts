import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // Node ignores these unless started with --enable-source-maps, and Nitro
  // does not carry them into its server bundle — 5.9 kB of the tarball that
  // nothing reads. Unminified output keeps stack traces readable without them.
  sourcemap: false,
  splitting: false,
  // tsup strips the node: prefix by default. The prefix is what tells a
  // bundler that fs and path are Node builtins and not npm packages, so a
  // client-side import fails loudly instead of resolving to a polyfill.
  removeNodeProtocol: false,
  minify: false,
  target: 'es2020',
  outDir: 'dist',
});
