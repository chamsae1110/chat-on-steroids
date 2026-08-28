import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindOpenAiCaller,
  bindOpenAiCallerForRequest,
  beginOpenAiCallerBootstrap,
  awaitOpenAiCallerConversation,
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

  it('admits one bootstrap response and one waiter while classifying extra gateway replicas as duplicates', async () => {
    const identity = resolveOpenAiCallerIdentity(
      undefined,
      openAiHeaderEvidence({ 'x-openai-session': 'fanout-session', 'x-openai-subject': 'fanout-subject' })
    );
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('first');
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('waiter');
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('duplicate');

    const waiting = awaitOpenAiCallerConversation(identity.key, 1_000);
    expect(bindOpenAiCaller(identity.key, 'conversation-fanout')).toBe(true);
    await expect(waiting).resolves.toBe('conversation-fanout');
    expect(beginOpenAiCallerBootstrap(identity.key)).toBe('resolved');
  });
});
