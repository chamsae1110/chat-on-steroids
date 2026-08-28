import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimOracleReadGrant,
  oracleGrantForCaller,
  resetOracleCallerGrantsForTests
} from '../src/main/mcp/oracle-caller-grant.js';

const RUN_ID = '20260829T010203Z-abcdef123456';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

describe('Oracle fresh Prime caller grants', () => {
  let temp = '';
  let stateRoot = '';
  let runDir = '';
  let projectRoot = '';
  let missionPath = '';

  beforeEach(async () => {
    resetOracleCallerGrantsForTests();
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'steroids-oracle-grant-'));
    stateRoot = path.join(temp, 'state', 'chatgpt-oracle');
    runDir = path.join(stateRoot, 'projects', 'project-key', 'runs', RUN_ID);
    projectRoot = path.join(temp, 'project');
    missionPath = path.join(projectRoot, 'mission.md');
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(missionPath, 'grant mission\n', 'utf8');
    await fs.writeFile(
      path.join(runDir, 'caller-identity-grant.json'),
      `${JSON.stringify({
        schema: 'codex.chatgpt.oracle-core-caller-grant/v1',
        run_id: RUN_ID,
        source_thread_id: '01a029cc-d9e3-7e42-8f3b-1a96f48da540',
        project_root: projectRoot,
        mission_path: missionPath,
        mission_sha256: sha('grant mission\n'),
        app_name: 'Chat On Steroids Core',
        transport: 'pro-devspace',
        model: 'gpt-5.6-sol',
        thinking_time: 'pro',
        token_sha256: sha(TOKEN),
        created_at_ms: Date.now(),
        expires_at_ms: Date.now() + 10 * 60_000
      }, null, 2)}\n`,
      'utf8'
    );
  });

  afterEach(async () => {
    resetOracleCallerGrantsForTests();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const claim = (callerKey = 'caller-a', token = TOKEN, paths = [missionPath]) =>
    claimOracleReadGrant({ callerKey, runId: RUN_ID, token, requestedPaths: paths, stateRoot });

  it('consumes one exact hash-bound mission grant without persisting the raw token', async () => {
    const result = await claim();
    expect(result).toMatchObject({
      ok: true,
      grant: { runId: RUN_ID, projectRoot: await fs.realpath(projectRoot), missionPath }
    });
    expect(oracleGrantForCaller('caller-a')).toMatchObject({ runId: RUN_ID, missionSha256: sha('grant mission\n') });
    const receipt = await fs.readFile(path.join(runDir, 'caller-identity-claim.json'), 'utf8');
    expect(receipt).toContain(sha(TOKEN));
    expect(receipt).not.toContain(TOKEN);
  });

  it('coalesces six replicas for the same official caller and one run', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => claim()));
    expect(results.every((entry) => entry.ok)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(runDir, 'caller-identity-claim.json'), 'utf8'))).toMatchObject({
      schema: 'codex.chatgpt.oracle-core-caller-claim/v1',
      run_id: RUN_ID
    });
  });

  it('rejects a wrong token, wrong mission path, changed mission, and a second caller', async () => {
    await expect(claim('caller-a', `${TOKEN}x`)).resolves.toMatchObject({ ok: false, code: 'ORACLE_CALLER_GRANT_TOKEN_MISMATCH' });
    await expect(claim('caller-a', TOKEN, [path.join(projectRoot, 'other.md')])).resolves.toMatchObject({
      ok: false,
      code: 'ORACLE_CALLER_GRANT_MISSION_MISMATCH'
    });
    await fs.writeFile(missionPath, 'changed\n', 'utf8');
    await expect(claim()).resolves.toMatchObject({ ok: false, code: 'ORACLE_CALLER_GRANT_MISSION_CHANGED' });
    await fs.writeFile(missionPath, 'grant mission\n', 'utf8');
    await expect(claim()).resolves.toMatchObject({ ok: true });
    await expect(claim('caller-b')).resolves.toMatchObject({ ok: false, code: 'ORACLE_CALLER_GRANT_ALREADY_CLAIMED' });
  });

  it('fails closed after process state is reset because the append-only claim already exists', async () => {
    await expect(claim()).resolves.toMatchObject({ ok: true });
    resetOracleCallerGrantsForTests();
    await expect(claim()).resolves.toMatchObject({ ok: false, code: 'ORACLE_CALLER_GRANT_ALREADY_CLAIMED' });
  });
});
