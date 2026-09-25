import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { format } from 'prettier';
import qrImage from 'qr-image';
const input = process.argv[2];
if (!input)
  throw new Error(
    'Usage: pnpm device:setup https://your-pc.your-tailnet.ts.net',
  );
const url = new URL(input);
if (
  !['http:', 'https:'].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash
) {
  throw new Error(
    'Pass an HTTP(S) origin without credentials, paths, query or hash',
  );
}
const manifestPath = new URL('../apps/even-g2/app.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.permissions = [
  {
    name: 'network',
    desc: 'Read dashboard state from your Agent Server.',
    whitelist: [url.origin],
  },
];
writeFileSync(
  manifestPath,
  await format(JSON.stringify(manifest), { parser: 'json' }),
);
// Ignored by git; the endpoint is environment-specific.
writeFileSync(
  new URL('../.env.local', import.meta.url),
  `VITE_AGENT_SERVER_URL=${url.origin}\n`,
);
mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../.local/device-qr.png', import.meta.url),
  qrImage.imageSync(url.origin, { type: 'png', size: 8, margin: 4 }),
);
console.log(
  `Configured ${url.origin}. QR: .local/device-qr.png. Run pnpm build, pnpm start, then scan the QR in Even App.`,
);
