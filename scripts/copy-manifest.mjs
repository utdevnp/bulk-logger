import { copyFile, cp } from 'node:fs/promises';

const browser = process.argv[2] || 'chrome';
const manifest = browser === 'firefox' ? 'manifest.firefox.json' : 'manifest.json';
const outputDirectory = browser === 'firefox' ? 'dist-firefox' : 'dist';

await Promise.all([
  copyFile(new URL(`../${manifest}`, import.meta.url), new URL(`../${outputDirectory}/manifest.json`, import.meta.url)),
  copyFile(new URL('../service-worker.js', import.meta.url), new URL(`../${outputDirectory}/service-worker.js`, import.meta.url)),
  cp(new URL('../icons/', import.meta.url), new URL(`../${outputDirectory}/icons`, import.meta.url), { recursive: true }),
]);
