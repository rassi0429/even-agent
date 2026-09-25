import { z } from 'zod';
const integer = (min: number, max: number) =>
  z.number().int().min(min).max(max);
const base = {
  id: z.string().min(1).max(64),
  x: integer(0, 575),
  y: integer(0, 287),
};
export const textElementSchema = z
  .object({
    ...base,
    type: z.literal('text'),
    width: integer(1, 576),
    height: integer(1, 288),
    text: z
      .string()
      .min(1)
      .max(999)
      .refine(
        (text) => new TextEncoder().encode(text).length <= 999,
        'Text must fit 999 UTF-8 bytes',
      ),
    padding: integer(0, 16).default(0),
    border: integer(0, 4).default(0),
    brightness: integer(0, 4).default(4),
  })
  .strict();
export const imageElementSchema = z
  .object({
    ...base,
    type: z.literal('image'),
    width: integer(20, 288).refine(
      (n) => n % 2 === 0,
      'Image width must be even',
    ),
    height: integer(20, 144),
    // One hex digit per pixel, row-major, 0=black / f=brightest. Two pixels per byte.
    frames: z
      .array(
        z
          .string()
          .min(400)
          .max(41472)
          .regex(/^[0-9a-f]+$/i)
          .transform((s) => s.toLowerCase()),
      )
      .min(1)
      .max(16),
    frameMs: integer(250, 60_000).default(500),
    loop: z.boolean().default(true),
  })
  .strict();
export const sceneElementSchema = z.discriminatedUnion('type', [
  textElementSchema,
  imageElementSchema,
]);
export const sceneSchema = z
  .object({ elements: z.array(sceneElementSchema).min(1).max(12) })
  .strict()
  .superRefine((scene, ctx) => {
    const ids = new Set<string>();
    let texts = 0,
      images = 0,
      pixels = 0;
    scene.elements.forEach((e, index) => {
      const issue = (message: string) =>
        ctx.addIssue({ code: 'custom', path: ['elements', index], message });
      if (ids.has(e.id)) issue('Element IDs must be unique');
      ids.add(e.id);
      if (e.x + e.width > 576 || e.y + e.height > 288)
        issue('Element exceeds 576x288 screen');
      if (e.type === 'text') {
        texts++;
        if (2 * (e.padding + e.border) >= Math.min(e.width, e.height))
          issue('Padding/border leaves no text area');
      } else {
        images++;
        for (const frame of e.frames) {
          if (frame.length !== e.width * e.height)
            issue('Frame length must equal width*height');
          pixels += frame.length;
        }
      }
    });
    if (texts > 8 || images > 4)
      ctx.addIssue({
        code: 'custom',
        message: 'Maximum 8 text and 4 image elements',
      });
    if (pixels > 1024 * 1024)
      ctx.addIssue({
        code: 'custom',
        message: 'Scene frame data exceeds 1 MiB',
      });
  });
export type Scene = z.infer<typeof sceneSchema>;
export type SceneElement = z.infer<typeof sceneElementSchema>;
export type ImageElement = z.infer<typeof imageElementSchema>;
export function frameIndex(
  image: ImageElement,
  elapsed: number,
  online = true,
): number {
  if (!online) return 0;
  const index = Math.floor(Math.max(0, elapsed) / image.frameMs);
  return image.loop
    ? index % image.frames.length
    : Math.min(index, image.frames.length - 1);
}
export function decodeGray4(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}
export function paintGray4(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): string {
  return Array.from({ length: width * height }, (_, index) =>
    Math.max(
      0,
      Math.min(15, Math.round(pixel(index % width, Math.floor(index / width)))),
    ).toString(16),
  ).join('');
}
