import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('apps/even-g2/app.json', root), 'utf8'),
);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
  throw new Error('Invalid release version');
const name = `agent-dashboard-${manifest.version}.ehpk`;
const output = new URL(`releases/${name}`, root);
mkdirSync(new URL('releases/', root), { recursive: true });
copyFileSync(new URL('.local/agent-dashboard.ehpk', root), output);
copyFileSync(
  new URL('docs/install-beta.md', root),
  new URL('releases/INSTALL-ja.md', root),
);
const sha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
writeFileSync(new URL(`releases/${name}.sha256`, root), `${sha256}  ${name}\n`);
console.log(`Prepared releases/${name}\nSHA256 ${sha256}`);
