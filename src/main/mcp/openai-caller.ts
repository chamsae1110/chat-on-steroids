/**
 * ChatGPT's transport-level caller identity.
 *
 * Current ChatGPT sends an anonymised subject and conversation id in
 * `_meta["openai/subject"]` / `_meta["openai/session"]`; the HTTP gateway also
 * exposes the same values as `x-openai-subject` / `x-openai-session`. The
 * metadata is canonical and the headers are a transport fallback. Contradictory
 * or malformed copies are never picked arbitrarily.
 *
 * Raw provider values are used only long enough to derive a process-local
 * SHA-256 join key. They are never logged or persisted.
 */

import { createHmac, randomBytes } from 'node:crypto';

interface OpaqueField {
  present: boolean;
  value: string | null;
}

export interface OpenAiHeaderEvidence {
  session: OpaqueField;
  subject: OpaqueField;
  organization: OpaqueField;
}

export interface OpenAiCallerIdentity {
  /** One-way, process-local registry key; never a raw OpenAI identifier. */
  key: string | null;
  /** A supplied identity field was malformed or contradicted another layer. */
  conflicted: boolean;
}

const MAX_OPAQUE_CHARS = 512;
const MAX_REQUEST_BINDINGS = 50_000;
const processKey = randomBytes(32);
const bindings = new Map<string, string | null>();
const callerByRequest = new Map<string, string | null>();
const bootstrap = new Map<string, { waiterClaimed: boolean }>();
const bindingWaiters = new Map<string, Set<() => void>>();

function wakeBinding(key: string): void {
  const waiters = bindingWaiters.get(key);
  if (!waiters) return;
  bindingWaiters.delete(key);
  for (const resolve of waiters) resolve();
}

function poison(key: string): void {
  bindings.set(key, null);
  wakeBinding(key);
}

function opaque(value: unknown, present: boolean): OpaqueField {
  if (!present) return { present: false, value: null };
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OPAQUE_CHARS) {
    return { present: true, value: null };
  }
  // Header/meta values are opaque, but control characters and surrounding
  // whitespace make two protocol representations ambiguous.
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    return { present: true, value: null };
  }
  return { present: true, value };
}

function header(value: string | string[] | undefined): OpaqueField {
  if (value === undefined) return opaque(undefined, false);
  if (Array.isArray(value)) {
    if (value.length !== 1) return opaque(null, true);
    return opaque(value[0], true);
  }
  return opaque(value, true);
}

export function openAiHeaderEvidence(headers: Record<string, string | string[] | undefined>): OpenAiHeaderEvidence {
  return {
    session: header(headers['x-openai-session']),
    subject: header(headers['x-openai-subject']),
    organization: header(headers['x-openai-organization'])
  };
}

function meta(meta: Record<string, unknown> | undefined, key: string): OpaqueField {
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, key)) return opaque(undefined, false);
  return opaque(meta[key], true);
}

function merge(canonical: OpaqueField, fallback: OpaqueField): OpaqueField & { conflicted: boolean } {
  if ((canonical.present && canonical.value === null) || (fallback.present && fallback.value === null)) {
    return { present: canonical.present || fallback.present, value: null, conflicted: true };
  }
  if (canonical.value !== null && fallback.value !== null && canonical.value !== fallback.value) {
    return { present: true, value: null, conflicted: true };
  }
  return {
    present: canonical.present || fallback.present,
    value: canonical.value ?? fallback.value,
    conflicted: false
  };
}

export function resolveOpenAiCallerIdentity(
  requestMeta: Record<string, unknown> | undefined,
  headers: OpenAiHeaderEvidence
): OpenAiCallerIdentity {
  const session = merge(meta(requestMeta, 'openai/session'), headers.session);
  const subject = merge(meta(requestMeta, 'openai/subject'), headers.subject);
  const organization = merge(meta(requestMeta, 'openai/organization'), headers.organization);
  if (session.conflicted || subject.conflicted || organization.conflicted) {
    return { key: null, conflicted: true };
  }
  // Requiring both fields avoids treating a generic user-scoped transport as
  // conversation authority. Organization is optional because current ChatGPT
  // does not always send it; when present it is included in the namespace.
  if (session.value === null || subject.value === null) return { key: null, conflicted: false };
  const key = createHmac('sha256', processKey)
    .update('openai-caller-v1\0')
    .update(organization.value ?? '')
    .update('\0')
    .update(subject.value)
    .update('\0')
    .update(session.value)
    .digest('hex');
  return { key, conflicted: false };
}

/** Exact conversation already proved for this ChatGPT caller in this app process. */
export function conversationForOpenAiCaller(key: string | null): string | null {
  return key ? bindings.get(key) ?? null : null;
}

/**
 * Binds one official ChatGPT caller to the conversation proved by the browser's
 * exact request-id join. A contradiction poisons the key for this process.
 */
export function bindOpenAiCaller(key: string | null, conversationId: string | null): boolean {
  if (!key || !conversationId) return false;
  if (!bindings.has(key)) {
    bindings.set(key, conversationId);
    wakeBinding(key);
    return true;
  }
  const held = bindings.get(key) ?? null;
  if (held === conversationId) return true;
  poison(key);
  return false;
}

export function openAiCallerConflicted(key: string | null): boolean {
  return Boolean(key && bindings.has(key) && bindings.get(key) === null);
}

/** True only while a valid official caller still needs its first exact page join. */
export function openAiCallerNeedsPageEvidence(key: string | null): boolean {
  return Boolean(key && !bindings.has(key));
}

export type OpenAiBootstrapPhase = 'first' | 'waiter' | 'duplicate' | 'resolved';

/**
 * Allows one immediate no-execution response and one coalesced waiter per
 * unbound official caller. ChatGPT can fan one logical tool call out to several
 * concurrent HTTP requests; only the waiter may proceed after page evidence,
 * preventing duplicate filesystem mutations.
 */
export function beginOpenAiCallerBootstrap(key: string | null): OpenAiBootstrapPhase {
  if (!key || bindings.has(key)) return 'resolved';
  const state = bootstrap.get(key);
  if (!state) {
    bootstrap.set(key, { waiterClaimed: false });
    return 'first';
  }
  if (!state.waiterClaimed) {
    state.waiterClaimed = true;
    return 'waiter';
  }
  return 'duplicate';
}

export async function awaitOpenAiCallerConversation(key: string | null, timeoutMs: number): Promise<string | null> {
  if (!key) return null;
  const immediate = conversationForOpenAiCaller(key);
  if (immediate || openAiCallerConflicted(key) || timeoutMs <= 0) return immediate;
  let timer: NodeJS.Timeout | null = null;
  await new Promise<void>((resolve) => {
    const waiters = bindingWaiters.get(key) ?? new Set<() => void>();
    waiters.add(resolve);
    bindingWaiters.set(key, waiters);
    timer = setTimeout(() => {
      waiters.delete(resolve);
      if (waiters.size === 0) bindingWaiters.delete(key);
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });
  if (timer) clearTimeout(timer);
  return conversationForOpenAiCaller(key);
}

/**
 * Remembers which official caller issued an exact MCP request id. The key is
 * already a process-keyed HMAC; neither provider identifier is retained.
 */
export function noteOpenAiCallerRequest(requestId: string | null, key: string | null): boolean {
  if (!requestId || !key) return true;
  if (!callerByRequest.has(requestId)) {
    callerByRequest.set(requestId, key);
    while (callerByRequest.size > MAX_REQUEST_BINDINGS) {
      const oldest = callerByRequest.keys().next().value as string | undefined;
      if (!oldest) break;
      callerByRequest.delete(oldest);
    }
    return true;
  }
  const held = callerByRequest.get(requestId) ?? null;
  if (held === key) return true;
  if (held) poison(held);
  poison(key);
  callerByRequest.set(requestId, null);
  return false;
}

/** Late page evidence can authenticate a caller even after its HTTP result ended. */
export function bindOpenAiCallerForRequest(requestId: string, conversationId: string): boolean {
  const key = callerByRequest.get(requestId) ?? null;
  return key ? bindOpenAiCaller(key, conversationId) : false;
}

/** A request id claimed by two page conversations poisons its transport caller too. */
export function conflictOpenAiCallerForRequest(requestId: string): void {
  const key = callerByRequest.get(requestId) ?? null;
  if (key) poison(key);
  if (callerByRequest.has(requestId)) callerByRequest.set(requestId, null);
}

/** Tests only: process restart naturally clears this registry. */
export function resetOpenAiCallerBindingsForTests(): void {
  bindings.clear();
  callerByRequest.clear();
  bootstrap.clear();
  bindingWaiters.clear();
}
