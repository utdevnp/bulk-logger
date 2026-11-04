import { copyFile } from 'node:fs/promises';

await Promise.all([
  copyFile(new URL('../manifest.json', import.meta.url), new URL('../dist/manifest.json', import.meta.url)),
  copyFile(new URL('../service-worker.js', import.meta.url), new URL('../dist/service-worker.js', import.meta.url)),
]);
