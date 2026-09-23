import { z } from 'zod';

/** Persistent outcomes: uncertain writes may only be reconciled, never blindly replayed. */
export const RemoteOperationState = z.enum(['prepared', 'attempting', 'ambiguous', 'needs_review', 'confirmed', 'rejected']);
export const ChannelResult = z.object({ title: z.string(), mediaId: z.string().min(1) }).passthrough();
export const FrozenPublication = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  email: z.object({
    name: z.string().min(1), body: z.string().min(1), subject: z.string(),
    subscription_topic_id: z.number().int().positive(),
    recipients: z.object({ and: z.array(z.object({ or: z.array(z.object({ segment: z.object({ id: z.number().int().positive() }) })).length(1) })).length(1) }),
  }).passthrough(),
  destinations: z.array(z.object({ destination: z.enum(['discord', 'wechat']), title: z.string(), payload: z.record(z.string(), z.unknown()) })),
  scheduledAt: z.number().int().positive().nullable(),
  timezone: z.string().min(1),
  existingRemoteId: z.union([z.string(), z.number()]).nullable(),
}).passthrough();
export const TranslationCheckpoint = z.object({
  version: z.number().int().optional(), key: z.string().min(1),
  translations: z.array(z.object({ id: z.string(), text: z.string() })),
  warnings: z.array(z.object({ id: z.string(), messages: z.array(z.string()) })).optional(),
  validationExceptions: z.array(z.object({ id: z.string() }).passthrough()).optional(),
}).passthrough();
