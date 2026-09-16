'use strict';

const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: ['src/index.js'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: 'dist/server.js',
    packages: 'external',
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
