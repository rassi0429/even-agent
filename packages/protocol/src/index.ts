import { z } from 'zod';
import { sceneSchema } from './scene.js';
export * from './scene.js';

export const sectionSchema = z.enum(['now', 'soon', 'waiting']);
export const prioritySchema = z.enum(['low', 'normal', 'high']);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const actionSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(60),
  })
  .strict();
export const createItemSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().max(1000).optional(),
    section: sectionSchema,
    priority: prioritySchema,
    source: z.string().trim().min(1).max(80),
    expiresAt: timestamp.optional(),
    actions: z.array(actionSchema).max(8).optional(),
  })
  .strict();
export const patchItemSchema = createItemSchema
  .partial()
  .extend({
    description: z.string().max(1000).nullable().optional(),
    expiresAt: timestamp.nullable().optional(),
    actions: z.array(actionSchema).max(8).nullable().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one field',
  );
export const itemSchema = createItemSchema.extend({
  id: z.string().min(1),
  createdAt: timestamp,
});
export const stateSchema = z.object({
  now: z.array(itemSchema),
  soon: z.array(itemSchema),
  waiting: z.array(itemSchema),
  updatedAt: timestamp,
});
export const stateMessageSchema = z.object({
  type: z.literal('state'),
  data: stateSchema,
});
export type DashboardSection = z.infer<typeof sectionSchema>;
export type Priority = z.infer<typeof prioritySchema>;
export type DashboardAction = z.infer<typeof actionSchema>;
export type DashboardItem = z.infer<typeof itemSchema>;
export type DashboardState = z.infer<typeof stateSchema>;
export type CreateDashboardItem = z.infer<typeof createItemSchema>;
export type PatchDashboardItem = z.infer<typeof patchItemSchema>;
export type StateMessage = z.infer<typeof stateMessageSchema>;
export const sections: DashboardSection[] = ['now', 'soon', 'waiting'];
export function emptyState(): DashboardState {
  return { now: [], soon: [], waiting: [], updatedAt: 0 };
}

// Device-facing protocol: already composed on the PC. No DashboardItem
// interpretation, prioritization, or text layout is required on the phone.
export const displayIconSchema = z.enum([
  'none',
  'running',
  'waiting',
  'done',
  'failed',
  'stopped',
  'unknown',
]);
export const displayIconRowSchema = z.object({
  text: z.string().min(1).max(160),
  icon: displayIconSchema,
  agent: z.enum(['codex', 'claude', 'none']).default('none'),
});
export type DisplayIcon = z.infer<typeof displayIconSchema>;
export type DisplayIconRow = z.infer<typeof displayIconRowSchema>;
const displayText = z
  .string()
  .min(1)
  .max(999)
  .refine(
    (value) => new TextEncoder().encode(value).length <= 999,
    'Fallback text must fit 999 UTF-8 bytes',
  );
export const displayPageSchema = z.object({
  id: z.string().min(1).max(100),
  content: displayText,
  offlineContent: displayText,
  // Optional v1 extension; older clients keep using content/offlineContent.
  iconRows: z.array(displayIconRowSchema).min(1).max(8).optional(),
  footer: z.string().max(80).optional(),
  scene: sceneSchema.optional(),
  offlineScene: sceneSchema.optional(),
});
export const displaySchema = z.object({
  version: z.literal(1),
  updatedAt: timestamp,
  generatedAt: timestamp,
  pages: z.array(displayPageSchema).min(1),
});
export const displayMessageSchema = z.object({
  type: z.literal('display'),
  data: displaySchema,
});
export type DisplayState = z.infer<typeof displaySchema>;
export const liveDisplaySchema = z
  .object({
    publisherId: z.string().uuid(),
    ttlSeconds: z.number().int().min(5).max(120).default(20),
    display: displaySchema.extend({
      pages: z.array(displayPageSchema).min(1).max(16),
    }),
  })
  .strict();
export const screenDocumentSchema = z
  .object({
    pages: z
      .array(
        displayPageSchema
          .omit({ iconRows: true, footer: true })
          .extend({ scene: sceneSchema })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (new Set(doc.pages.map((p) => p.id)).size !== doc.pages.length)
      ctx.addIssue({ code: 'custom', message: 'Page IDs must be unique' });
    if (new TextEncoder().encode(JSON.stringify(doc)).length > 4 * 1024 * 1024)
      ctx.addIssue({
        code: 'custom',
        message: 'Screen document exceeds 4 MiB',
      });
  });
export type ScreenDocument = z.infer<typeof screenDocumentSchema>;

// Client-reported G2 telemetry, independent from display authoring. No serial number.
export const deviceTelemetrySchema = z
  .object({
    model: z.literal('g2'),
    connected: z.boolean(),
    batteryLevel: z.number().int().min(0).max(100).nullable(),
    isCharging: z.boolean().nullable(),
    connectionState: z
      .enum([
        'none',
        'connecting',
        'connected',
        'disconnected',
        'connectionFailed',
      ])
      .nullable()
      .optional(),
    isWearing: z.boolean().nullable().optional(),
    isInCase: z.boolean().nullable().optional(),
    launchSource: z.enum(['appMenu', 'glassesMenu']).nullable().optional(),
    controlVersion: z.literal(1).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.connectionState == null ||
      v.connected === (v.connectionState === 'connected'),
    'Inconsistent connection state',
  );
export const deviceTelemetryMessageSchema = z
  .object({
    type: z.literal('deviceStatus'),
    data: deviceTelemetrySchema,
  })
  .strict();
export type DeviceTelemetry = z.infer<typeof deviceTelemetrySchema>;

// Passive SDK events only; raw sensor/audio/user payloads never enter this channel.
export const deviceEventSchema = z
  .object({
    kind: z.enum([
      'tap',
      'double-tap',
      'scroll-top',
      'scroll-bottom',
      'long-press',
      'long-press-release',
      'overlay-open',
      'overlay-close',
      'exit',
      'abnormal-exit',
    ]),
    channel: z.enum(['system', 'text', 'list']),
    source: z.enum(['left-temple', 'right-temple', 'ring', 'unknown']),
    containerId: z.number().int().min(0).max(65535).optional(),
    itemIndex: z.number().int().min(0).max(65535).optional(),
  })
  .strict();
export const deviceEventMessageSchema = z
  .object({
    type: z.literal('deviceEvent'),
    data: deviceEventSchema,
  })
  .strict();
export type DeviceEvent = z.infer<typeof deviceEventSchema>;

export * from './sensors.js';
