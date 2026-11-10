/** Small shared helpers with no dependencies. */

export const nowIso = (): string => new Date().toISOString();

export const uuid = (): string => crypto.randomUUID();
