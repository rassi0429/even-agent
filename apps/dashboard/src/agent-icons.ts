import type { DisplayIcon, DisplayIconRow } from '@even-agent/protocol';
export const ICON_WIDTH = 48;
export const ROW_HEIGHT = 28;
export const STRIP_HEIGHT = ROW_HEIGHT * 4;
export const FRAME_MS = 500;

// Monochrome pixel-art emblems: interwoven Codex knot and Claude starburst.
export const AGENT_SPRITES = {
  codex: [
    '000000111111000000',
    '000011110011110000',
    '000110000000011000',
    '001100011110001100',
    '111000110011000111',
    '110001100001100011',
    '110011001100110011',
    '110110011110011011',
    '011100110011001110',
    '011100110011001110',
    '110110011110011011',
    '110011001100110011',
    '110001100001100011',
    '111000110011000111',
    '001100011110001100',
    '000110000000011000',
    '000011110011110000',
    '000000111111000000',
  ],
  claude: [
    '000000001100000000',
    '001000001100001000',
    '001100001100011000',
    '000110001100110000',
    '000011001101100000',
    '110001101111001011',
    '011100111110111110',
    '000111111111110000',
    '111111111111111111',
    '111111111111111111',
    '000111111111110000',
    '011100111110111110',
    '110001101111001011',
    '000011001101100000',
    '000110001100110000',
    '001100001100011000',
    '001000001100001000',
    '000000001100000000',
  ],
};

// Code-drawn, packed Gray4 sprites; no device font dependency.
function pixel(icon: DisplayIcon, x: number, y: number, frame: number): number {
  const dx = x - 11.5,
    dy = y - 13.5;
  if (icon === 'running') {
    for (let dot = 0; dot < 8; dot++) {
      const angle = (dot * Math.PI) / 4 - Math.PI / 2;
      if (Math.hypot(dx - Math.cos(angle) * 7, dy - Math.sin(angle) * 7) <= 1.8)
        return [15, 12, 9, 6, 4, 3, 2, 2][(frame - dot + 8) % 8]!;
    }
  } else if (icon === 'waiting') {
    if (Math.abs(dx) <= 1.5 && ((dy >= -7 && dy <= 2) || (dy >= 5 && dy <= 7)))
      return 15;
  } else if (icon === 'done') {
    if (
      (dx >= -8 && dx <= -2 && Math.abs(dy - (dx + 7)) <= 1.3) ||
      (dx >= -2 && dx <= 8 && Math.abs(dy - (-dx + 3)) <= 1.3)
    )
      return 15;
  } else if (icon === 'failed') {
    if (
      Math.abs(dx) <= 7 &&
      Math.abs(dy) <= 7 &&
      Math.abs(Math.abs(dx) - Math.abs(dy)) <= 1.4
    )
      return 15;
  } else if (icon === 'stopped') {
    if (Math.abs(dy) <= 7 && Math.abs(dx) >= 3 && Math.abs(dx) <= 5) return 12;
  } else if (icon === 'unknown') {
    if (Math.abs(Math.hypot(dx, dy) - 6.5) <= 1) return 6;
  }
  return 0;
}
export function iconStrip(
  rows: DisplayIconRow[],
  strip: number,
  frame: number,
  online: boolean,
): Uint8Array {
  const data = new Uint8Array((ICON_WIDTH * STRIP_HEIGHT) / 2);
  for (let y = 0; y < STRIP_HEIGHT; y++) {
    const row = rows[strip * 4 + Math.floor(y / ROW_HEIGHT)];
    let icon = row?.icon || 'none';
    if (!online && icon === 'running') icon = 'unknown';
    for (let x = 0; x < ICON_WIDTH; x++) {
      const index = y * ICON_WIDTH + x;
      const agent = row?.agent || 'none';
      const sprite = agent === 'none' ? undefined : AGENT_SPRITES[agent];
      const brightness =
        x < 24
          ? pixel(icon, x, y % ROW_HEIGHT, frame)
          : sprite?.[(y % ROW_HEIGHT) - 5]?.[x - 27] === '1'
            ? 15
            : 0;
      data[index >> 1]! |= brightness << (index % 2 === 0 ? 4 : 0);
    }
  }
  return data;
}
