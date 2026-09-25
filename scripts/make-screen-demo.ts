import { mkdirSync, writeFileSync } from 'node:fs';
import {
  paintGray4,
  screenDocumentSchema,
} from '../packages/protocol/src/index.js';
// Example authoring code runs on the PC; no app-bundled icon identifiers.
const curve = paintGray4(288, 100, (x, y) => {
  if (y === 90 || x === 8) return 5;
  if (x % 48 === 0 || y % 20 === 0) return 2;
  return Math.abs(y - (58 - 24 * Math.sin(x / 32) - x / 15)) < 2 ? 15 : 0;
});
const frames = Array.from({ length: 8 }, (_, frame) =>
  paintGray4(64, 64, (x, y) => {
    for (let dot = 0; dot < 8; dot++) {
      const angle = (dot * Math.PI) / 4 - Math.PI / 2;
      if (
        Math.hypot(
          x - 31.5 - Math.cos(angle) * 22,
          y - 31.5 - Math.sin(angle) * 22,
        ) < 4
      )
        return [15, 12, 9, 6, 4, 3, 2, 1][(frame - dot + 8) % 8]!;
    }
    return 0;
  }),
);
const document = screenDocumentSchema.parse({
  pages: [
    {
      id: 'custom-demo',
      content: 'Generic screen demo\nText / image / animation\nSample data',
      offlineContent: 'OFFLINE\nGeneric screen demo (cached)',
      scene: {
        elements: [
          {
            type: 'text',
            id: 'title',
            x: 20,
            y: 8,
            width: 536,
            height: 32,
            text: 'PC -> G2 / GENERIC SCREEN',
          },
          {
            type: 'text',
            id: 'description',
            x: 20,
            y: 42,
            width: 536,
            height: 32,
            text: 'テキスト・画像・アニメーション',
          },
          {
            type: 'image',
            id: 'chart',
            x: 20,
            y: 90,
            width: 288,
            height: 100,
            frames: [curve],
          },
          {
            type: 'image',
            id: 'spinner',
            x: 366,
            y: 100,
            width: 64,
            height: 64,
            frames,
            frameMs: 400,
          },
          {
            type: 'text',
            id: 'chart-caption',
            x: 20,
            y: 204,
            width: 308,
            height: 32,
            text: 'PCから自由に配置',
          },
          {
            type: 'text',
            id: 'animation-caption',
            x: 340,
            y: 184,
            width: 220,
            height: 60,
            text: '8 frames\n400 ms',
          },
          {
            type: 'text',
            id: 'footer',
            x: 20,
            y: 256,
            width: 536,
            height: 28,
            text: 'サンプル / 実データではありません',
            brightness: 3,
          },
        ],
      },
    },
  ],
});
mkdirSync(new URL('../examples/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../examples/screen-demo.json', import.meta.url),
  JSON.stringify(document, null, 2) + '\n',
);
console.log(
  'Created examples/screen-demo.json (not sent). Use: pnpm screen set examples/screen-demo.json',
);
