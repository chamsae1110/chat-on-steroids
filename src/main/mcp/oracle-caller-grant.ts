/**
 * One-use authority for an Oracle-opened fresh Prime conversation.
 *
 * Browser page state cannot expose the provider's opaque `openai/session` before
 * the first Core call, while old dormant worker histories mean that an unbound
 * caller cannot safely be treated as Prime. Oracle therefore writes a narrow
 * hash-only grant beside a newly prepared run and puts the random token only in
 * that new conversation's prompt. The first exact mission read consumes it and
 * binds the official transport caller for this app process.
 *
 * No raw token is stored, logged, returned, or recorded. A process restart,
 * expired grant, changed mission, second caller, existing claim receipt, or any
 * path other than the exact mission fails closed.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GRANT_SCHEMA = 'codex.chatgpt.oracle-core-caller-grant/v1';
const CLAIM_SCHEMA = 'codex.chatgpt.oracle-core-caller-claim/v1';
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OracleCallerGrant {
  runId: string;
  sourceThreadId: string;
  projectRoot: string;
  missionPath: string;
  missionSha256: string;
  expiresAtMs: number;
  grantSha256: string;
}

export type OracleGrantClaimResult =
  | { ok: true; grant: OracleCallerGrant }
  | { ok: false; code: string };

const grantByCaller = new Map<string, OracleCallerGrant>();
const callerByRun = new Map<string, string>();
const claimFlights = new Map<string, Promise<OracleGrantClaimResult>>();

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function defaultOracleStateRoot(): string {
  const codexHome = process.env['CODEX_HOME'];
  return path.resolve(codexHome && codexHome.trim() ? codexHome : path.join(os.homedir(), '.codex'), 'state', 'chatgpt-oracle');
}

async function exactGrantPath(stateRoot: string, runId: string): Promise<string | null> {
  const projects = path.join(stateRoot, 'projects');
  const canonicalStateRoot = await fs.realpath(stateRoot).catch(() => path.resolve(stateRoot));
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const entry of entries.slice(0, 10_000)) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projects, entry.name, 'runs', runId, 'caller-identity-grant.json');
    try {
      if ((await fs.lstat(candidate)).isFile()) {
        const real = await fs.realpath(candidate);
        if (contained(canonicalStateRoot, real)) matches.push(real);
      }
    } catch {
      // This project has no exact run/grant; keep searching the bounded project list.
    }
    if (matches.length > 1) return null;
  }
  return matches.length === 1 ? matches[0]! : null;
}

async function readGrant(
  stateRoot: string,
  runId: string,
  token: string,
  requestedPaths: readonly string[]
): Promise<{ grant: OracleCallerGrant; grantPath: string } | { code: string }> {
  if (!RUN_ID.test(runId) || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return { code: 'ORACLE_CALLER_GRANT_INPUT_INVALID' };
  const grantPath = await exactGrantPath(stateRoot, runId);
  if (!grantPath) return { code: 'ORACLE_CALLER_GRANT_NOT_FOUND_OR_AMBIGUOUS' };
  let bytes: Buffer;
  let raw: Record<string, unknown>;
  try {
    bytes = await fs.readFile(grantPath);
    raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { code: 'ORACLE_CALLER_GRANT_INVALID' };
  }
  const projectRootRaw = typeof raw['project_root'] === 'string' ? raw['project_root'] : '';
  const missionPathRaw = typeof raw['mission_path'] === 'string' ? raw['mission_path'] : '';
  const projectRoot = projectRootRaw && path.isAbsolute(projectRootRaw) ? path.resolve(projectRootRaw) : '';
  const missionPath = missionPathRaw && path.isAbsolute(missionPathRaw) ? path.resolve(missionPathRaw) : '';
  const missionSha256 = typeof raw['mission_sha256'] === 'string' ? raw['mission_sha256'].toLowerCase() : '';
  const sourceThreadId = typeof raw['source_thread_id'] === 'string' ? raw['source_thread_id'] : '';
  const tokenSha256 = typeof raw['token_sha256'] === 'string' ? raw['token_sha256'].toLowerCase() : '';
  const createdAtMs = typeof raw['created_at_ms'] === 'number' ? raw['created_at_ms'] : NaN;
  const expiresAtMs = typeof raw['expires_at_ms'] === 'number' ? raw['expires_at_ms'] : NaN;
  const now = Date.now();
  if (
    raw['schema'] !== GRANT_SCHEMA ||
    raw['run_id'] !== runId ||
    raw['app_name'] !== 'Chat On Steroids Core' ||
    raw['transport'] !== 'pro-devspace' ||
    raw['model'] !== 'gpt-5.6-sol' ||
    raw['thinking_time'] !== 'pro' ||
    !projectRoot ||
    !missionPath ||
    !contained(projectRoot, missionPath) ||
    !SHA256.test(missionSha256) ||
    !SHA256.test(tokenSha256) ||
    !THREAD_ID.test(sourceThreadId) ||
    !Number.isSafeInteger(createdAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    createdAtMs > now + 60_000 ||
    expiresAtMs <= now ||
    expiresAtMs <= createdAtMs ||
    expiresAtMs - createdAtMs > 60 * 60_000
  ) return { code: 'ORACLE_CALLER_GRANT_INVALID' };
  if (!safeEqualHex(digest(token), tokenSha256)) return { code: 'ORACLE_CALLER_GRANT_TOKEN_MISMATCH' };
  if (requestedPaths.length !== 1 || path.resolve(requestedPaths[0] ?? '') !== missionPath) {
    return { code: 'ORACLE_CALLER_GRANT_MISSION_MISMATCH' };
  }
  try {
    if ((await fs.lstat(projectRoot)).isSymbolicLink() || (await fs.lstat(missionPath)).isSymbolicLink()) {
      return { code: 'ORACLE_CALLER_GRANT_MISSION_CHANGED' };
    }
    const canonicalRoot = await fs.realpath(projectRoot);
    const canonicalMission = await fs.realpath(missionPath);
    if (!contained(canonicalRoot, canonicalMission)) return { code: 'ORACLE_CALLER_GRANT_MISSION_MISMATCH' };
    if (!safeEqualHex(digest(await fs.readFile(missionPath)), missionSha256)) {
      return { code: 'ORACLE_CALLER_GRANT_MISSION_CHANGED' };
    }
  } catch {
    return { code: 'ORACLE_CALLER_GRANT_MISSION_CHANGED' };
  }
  return {
    grantPath,
    grant: {
      runId,
      sourceThreadId,
      projectRoot: await fs.realpath(projectRoot),
      missionPath,
      missionSha256,
      expiresAtMs,
      grantSha256: digest(bytes)
    }
  };
}

async function claimOnce(
  callerKey: string,
  runId: string,
  token: string,
  requestedPaths: readonly string[],
  stateRoot: string
): Promise<OracleGrantClaimResult> {
  const held = grantByCaller.get(callerKey);
  if (held) {
    return held.runId === runId && held.expiresAtMs > Date.now()
      ? { ok: true, grant: held }
      : { ok: false, code: 'ORACLE_CALLER_GRANT_CALLER_CONFLICT' };
  }
  const runCaller = callerByRun.get(runId);
  if (runCaller) {
    return runCaller === callerKey
      ? { ok: true, grant: grantByCaller.get(callerKey)! }
      : { ok: false, code: 'ORACLE_CALLER_GRANT_ALREADY_CLAIMED' };
  }
  const read = await readGrant(stateRoot, runId, token, requestedPaths);
  if ('code' in read) return { ok: false, code: read.code };
  const claimPath = path.join(path.dirname(read.grantPath), 'caller-identity-claim.json');
  const receipt = {
    schema: CLAIM_SCHEMA,
    run_id: runId,
    source_thread_id: read.grant.sourceThreadId,
    project_root_sha256: digest(read.grant.projectRoot),
    mission_sha256: read.grant.missionSha256,
    grant_sha256: read.grant.grantSha256,
    token_sha256: digest(token),
    claimed_at_ms: Date.now()
  };
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(claimPath, 'wx');
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch {
    return { ok: false, code: 'ORACLE_CALLER_GRANT_ALREADY_CLAIMED' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  grantByCaller.set(callerKey, read.grant);
  callerByRun.set(runId, callerKey);
  return { ok: true, grant: read.grant };
}

export function claimOracleReadGrant(input: {
  callerKey: string | null;
  runId: string;
  token: string;
  requestedPaths: readonly string[];
  stateRoot?: string;
}): Promise<OracleGrantClaimResult> {
  if (!input.callerKey) return Promise.resolve({ ok: false, code: 'ORACLE_CALLER_IDENTITY_REQUIRED' });
  const stateRoot = path.resolve(input.stateRoot ?? defaultOracleStateRoot());
  const existing = claimFlights.get(input.runId);
  if (existing) {
    return existing.then(() => claimOnce(input.callerKey!, input.runId, input.token, input.requestedPaths, stateRoot));
  }
  const flight = claimOnce(input.callerKey, input.runId, input.token, input.requestedPaths, stateRoot);
  claimFlights.set(input.runId, flight);
  void flight.finally(() => {
    if (claimFlights.get(input.runId) === flight) claimFlights.delete(input.runId);
  }).catch(() => undefined);
  return flight;
}

export function oracleGrantForCaller(callerKey: string | null): OracleCallerGrant | null {
  if (!callerKey) return null;
  const held = grantByCaller.get(callerKey) ?? null;
  if (!held || held.expiresAtMs <= Date.now()) {
    if (held) {
      grantByCaller.delete(callerKey);
      if (callerByRun.get(held.runId) === callerKey) callerByRun.delete(held.runId);
    }
    return null;
  }
  return { ...held };
}

export function resetOracleCallerGrantsForTests(): void {
  grantByCaller.clear();
  callerByRun.clear();
  claimFlights.clear();
}
