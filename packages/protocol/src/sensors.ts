import { z } from 'zod';

const sessionId = z.string().uuid();
const durationSeconds = z.number().int().min(1).max(600).default(60);
export const sensorRequestSchema = z.discriminatedUnion('sensor', [
  z
    .object({
      sensor: z.literal('audio'),
      action: z.enum(['start', 'stop']),
      sessionId: sessionId.optional(),
      source: z.enum(['glasses', 'phone']).default('glasses'),
      durationSeconds,
    })
    .strict(),
  z
    .object({
      sensor: z.literal('imu'),
      action: z.enum(['start', 'stop']),
      sessionId: sessionId.optional(),
      reportFrq: z
        .union([
          z.literal(100),
          z.literal(200),
          z.literal(300),
          z.literal(400),
          z.literal(500),
          z.literal(600),
          z.literal(700),
          z.literal(800),
          z.literal(900),
          z.literal(1000),
        ])
        .default(100),
      durationSeconds,
    })
    .strict(),
]);
export type SensorRequest = z.infer<typeof sensorRequestSchema>;
export type Sensor = SensorRequest['sensor'];
export const sensorCommandSchema = z
  .object({
    type: z.literal('sensorCommand'),
    id: sessionId,
    streamId: sessionId,
    request: sensorRequestSchema,
  })
  .strict();
export type SensorCommand = z.infer<typeof sensorCommandSchema>;
export const sensorAckSchema = z
  .object({
    type: z.literal('sensorAck'),
    id: sessionId,
    ok: z.boolean(),
    error: z.string().max(160).optional(),
  })
  .strict();
export const sensorStoppedSchema = z
  .object({
    type: z.literal('sensorStopped'),
    streamId: sessionId,
    sensor: z.enum(['audio', 'imu']),
    reason: z.enum([
      'expired',
      'disconnect',
      'device-disconnected',
      'stopped',
      'error',
    ]),
    confirmed: z.boolean(),
  })
  .strict();
const frame = {
  type: z.literal('sensorFrame'),
  streamId: sessionId,
  sequence: z.number().int().nonnegative(),
};
export const sensorFrameSchema = z.discriminatedUnion('sensor', [
  z
    .object({
      ...frame,
      sensor: z.literal('audio'),
      pcmBase64: z
        .string()
        .min(4)
        .max(21848)
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        ),
      source: z.enum(['glasses', 'phone']),
      direction: z.number().int().min(-32768).max(32767).nullable(),
      speakerRole: z.enum(['self', 'other', 'unknown']),
    })
    .strict(),
  z
    .object({
      ...frame,
      sensor: z.literal('imu'),
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
    })
    .strict(),
]);
export type SensorFrame = z.infer<typeof sensorFrameSchema>;
export type SensorUpMessage =
  | z.infer<typeof sensorAckSchema>
  | z.infer<typeof sensorStoppedSchema>
  | SensorFrame;
