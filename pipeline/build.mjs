// Bundles src/ into one ESM file (dependencies stay external) + emits type declarations.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: true, logLevel: 'info' });
execSync('npx tsc -p tsconfig.json', { stdio: 'inherit' });
console.log('built dist/index.js + dist/*.d.ts');
