export type EnvFileUndeliverableReason = 'empty' | 'multiline' | 'quote';

/** Discriminated union so a failed check always carries its reason. */
export type EnvFileDeliverability = { ok: true } | { ok: false; reason: EnvFileUndeliverableReason };

/**
 * Whether `value` can be written as one `KEY='value'` line in an env file, which Compose reads literally.
 * A `'` in the value would end the quote, and single quotes have no escape.
 */
export function isEnvFileDeliverable(value: string): EnvFileDeliverability {
  if (value === '') return { ok: false, reason: 'empty' };
  if (value.includes('\n') || value.includes('\r')) return { ok: false, reason: 'multiline' };
  if (value.includes("'")) return { ok: false, reason: 'quote' };
  return { ok: true };
}
