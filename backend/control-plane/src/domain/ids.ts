/**
 * Prefixed, opaque identifiers — the Stripe convention (docs/10 §Identifiers).
 *
 * Readable in logs, safe in URLs, and they leak nothing about volume. The branded
 * types make it a compile error to pass a workspace id where an agent id belongs,
 * which in a multi-tenant system is a class of bug worth spending types on.
 */

import { customAlphabet } from 'nanoid';

// Lowercase alphanumerics, no ambiguous characters (no l, 1, o, 0).
const alphabet = '23456789abcdefghijkmnpqrstuvwxyz';
const generate = customAlphabet(alphabet, 12);

export const ID_PREFIXES = {
  user: 'usr',
  org: 'org',
  workspace: 'ws',
  agent: 'agt',
  agentVersion: 'agv',
  call: 'call',
  turn: 'turn',
  phoneNumber: 'pn',
  campaign: 'camp',
  lead: 'lead',
  apiKey: 'key',
  invitation: 'inv',
  membership: 'mem',
  tool: 'tool',
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;

/** Branded string — `AgentId` is not assignable to `WorkspaceId`. */
export type Id<K extends EntityKind> = string & { readonly __brand: K };

export type UserId = Id<'user'>;
export type OrgId = Id<'org'>;
export type WorkspaceId = Id<'workspace'>;
export type AgentId = Id<'agent'>;
export type CallId = Id<'call'>;
export type ApiKeyId = Id<'apiKey'>;

export function newId<K extends EntityKind>(kind: K): Id<K> {
  return `${ID_PREFIXES[kind]}_${generate()}` as Id<K>;
}

export function isId<K extends EntityKind>(kind: K, value: string): value is Id<K> {
  return value.startsWith(`${ID_PREFIXES[kind]}_`);
}

/** Parse-or-throw, for route params. */
export function assertId<K extends EntityKind>(kind: K, value: string): Id<K> {
  if (!isId(kind, value)) {
    throw new Error(`expected a ${kind} id (${ID_PREFIXES[kind]}_…), got "${value}"`);
  }
  return value;
}

/** API keys carry their mode in the prefix so a leaked key is instantly classifiable. */
export function newApiKeySecret(mode: 'test' | 'live'): { secret: string; prefix: string } {
  const body = customAlphabet(alphabet, 32)();
  const secret = `key_${mode}_${body}`;
  return { secret, prefix: `key_${mode}_${body.slice(0, 6)}` };
}
