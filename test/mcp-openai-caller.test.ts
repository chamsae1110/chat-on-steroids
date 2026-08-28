import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindOpenAiCaller,
  bindOpenAiCallerForRequest,
  beginOpenAiCallerBootstrap,
  coalesceOpenAiCallerExecution,
  conflictOpenAiCallerForRequest,
  conversationForOpenAiCaller,
  openAiCallerConflicted,
  openAiHeaderEvidence,
  noteOpenAiCallerRequest,
  resetOpenAiCallerBindingsForTests,
  resolveOpenAiCallerIdentity
} from '../src/main/mcp/openai-caller.js';

describe('OpenAI MCP caller identity', () => {
  beforeEach(() => resetOpenAiCallerBindingsForTests());

  it('accepts matching canonical metadata and transport fallback without retaining raw values', () => {
    const rawSession = 'session-anonymous-value';
    const rawSubject = 'subject-anonymous-value';
    const identity = resolveOpenAiCallerIdentity(
      { 'openai/session': rawSession, 'openai/subject': rawSubject },
      openAiHeaderEvidence({
        'x-openai-session': rawSession,
        'x-openai-subject': rawSubject
      })
    );

    expect(identity.conflicted).toBe(false);
    expect(identity.key).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.key).not.toContain(rawSession);
    expect(identity.key).not.toContain(rawSubject);
  });

  it('uses the observed HTTP fields only when canonical metadata is absent', () => {
    const identity = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({
        'x-openai-session': 'header-session',
        'x-openai-subject': 'header-subject'
      })
    );
    expect(identity).toMatchObject({ conflicted: false });
    expect(identity.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses mismatched, duplicate, malformed, or subjectless evidence', () => {
    const matchingHeaders = openAiHeaderEvidence({
      'x-openai-session': 'header-session',
      'x-openai-subject': 'header-subject'
    });
    expect(
      resolveOpenAiCallerIdentity(
        { 'openai/session': 'different-session', 'openai/subject': 'header-subject' },
        matchingHeaders
      )
    ).toEqual({ key: null, conflicted: true });
    expect(
      resolveOpenAiCallerIdentity(
        undefined,
        openAiHeaderEvidence({
          'x-openai-session': ['one', 'two'],
          'x-openai-subject': 'header-subject'
        })
      )
    ).toEqual({ key: null, conflicted: true });
    expect(
      resolveOpenAiCallerIdentity(
        { 'openai/session': ' session-with-space', 'openai/subject': 'header-subject' },
        openAiHeaderEvidence({})
      )
    ).toEqual({ key: null, conflicted: true });
    expect(
      resolveOpenAiCallerIdentity(
        undefined,
        openAiHeaderEvidence({ 'x-openai-session': 'session-only' })
      )
    ).toEqual({ key: null, conflicted: false });
  });

  it('keeps an exact binding sticky and poisons a contradictory conversation claim', () => {
    const identity = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({
        'x-openai-session': 'sticky-session',
        'x-openai-subject': 'sticky-subject'
      })
    );
    expect(bindOpenAiCaller(identity.key, 'conversation-a')).toBe(true);
    expect(bindOpenAiCaller(identity.key, 'conversation-a')).toBe(true);
    expect(conversationForOpenAiCaller(identity.key)).toBe('conversation-a');

    expect(bindOpenAiCaller(identity.key, 'conversation-b')).toBe(false);
    expect(conversationForOpenAiCaller(identity.key)).toBeNull();
    expect(openAiCallerConflicted(identity.key)).toBe(true);
    expect(bindOpenAiCaller(identity.key, 'conversation-a')).toBe(false);
  });

  it('lets late exact page evidence bind a completed request and poisons request-key reuse', () => {
    const one = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({ 'x-openai-session': 'late-one', 'x-openai-subject': 'subject' })
    );
    const two = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({ 'x-openai-session': 'late-two', 'x-openai-subject': 'subject' })
    );
    expect(noteOpenAiCallerRequest('wfr_late', one.key)).toBe(true);
    expect(bindOpenAiCallerForRequest('wfr_late', 'conversation-late')).toBe(true);
    expect(conversationForOpenAiCaller(one.key)).toBe('conversation-late');

    expect(noteOpenAiCallerRequest('wfr_late', two.key)).toBe(false);
    expect(openAiCallerConflicted(one.key)).toBe(true);
    expect(openAiCallerConflicted(two.key)).toBe(true);
  });

  it('accepts an earlier exact page scope when it equals the official opaque session', () => {
    const rawSession = 'bbf09ac8-787c-47e5-9693-9b3e88352f23';
    // The page can publish this conversation-scope request before any MCP call.
    expect(bindOpenAiCallerForRequest(rawSession, 'conversation-early-scope')).toBe(false);

    const identity = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({
        'x-openai-session': rawSession,
        'x-openai-subject': 'subject-early-scope'
      })
    );
    expect(conversationForOpenAiCaller(identity.key)).toBe('conversation-early-scope');
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('resolved');
  });

  it('does not substitute a different page request id for the official opaque session', () => {
    expect(bindOpenAiCallerForRequest('page-scope-a', 'conversation-a')).toBe(false);
    const identity = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({
        'x-openai-session': 'official-scope-b',
        'x-openai-subject': 'subject-b'
      })
    );
    expect(conversationForOpenAiCaller(identity.key)).toBeNull();
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('first');
  });

  it('poisons an official scope claimed by two page conversations', () => {
    const rawSession = 'page-scope-conflict';
    expect(bindOpenAiCallerForRequest(rawSession, 'conversation-a')).toBe(false);
    const identity = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({
        'x-openai-session': rawSession,
        'x-openai-subject': 'subject-conflict'
      })
    );
    expect(conversationForOpenAiCaller(identity.key)).toBe('conversation-a');

    conflictOpenAiCallerForRequest(rawSession);
    expect(conversationForOpenAiCaller(identity.key)).toBeNull();
    expect(openAiCallerConflicted(identity.key)).toBe(true);
  });

  it('fails closed if one opaque scope appears under two official subjects', () => {
    const rawSession = 'shared-opaque-scope';
    expect(bindOpenAiCallerForRequest(rawSession, 'conversation-shared')).toBe(false);
    const first = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({
        'x-openai-session': rawSession,
        'x-openai-subject': 'subject-one'
      })
    );
    const second = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({
        'x-openai-session': rawSession,
        'x-openai-subject': 'subject-two'
      })
    );
    expect(openAiCallerConflicted(first.key)).toBe(true);
    expect(openAiCallerConflicted(second.key)).toBe(true);
    expect(conversationForOpenAiCaller(first.key)).toBeNull();
    expect(conversationForOpenAiCaller(second.key)).toBeNull();
  });

  it('keeps every unbound gateway replica in immediate no-execution bootstrap until page evidence binds it', () => {
    const identity = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({ 'x-openai-session': 'fanout-session', 'x-openai-subject': 'fanout-subject' })
    );
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('first');
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('pending');
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('pending');

    expect(bindOpenAiCaller(identity.key, 'conversation-fanout')).toBe(true);
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('resolved');
  });

  it('coalesces only concurrent replicas of the same exact official wire request', async () => {
    const identity = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({ 'x-openai-session': 'singleflight-session', 'x-openai-subject': 'subject' })
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    const run = async () => {
      executions += 1;
      await held;
      return { execution: executions };
    };
    const replicas = Array.from({ length: 6 }, () =>
      coalesceOpenAiCallerExecution(identity.key, 'wfr_singleflight', 's:rpc-7', run)
    );
    await Promise.resolve();
    expect(executions).toBe(1);
    release();
    await expect(Promise.all(replicas)).resolves.toEqual(Array.from({ length: 6 }, () => ({ execution: 1 })));

    await coalesceOpenAiCallerExecution(identity.key, 'wfr_singleflight', 's:rpc-8', run);
    expect(executions).toBe(2);
  });
});
