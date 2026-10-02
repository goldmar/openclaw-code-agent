// Closed projections for the disposable issue-501 host. Full profiles and
// config command streams are internal inputs, never exportable receipts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
const digest = (text) => ({ bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
const own = (value, key) => Object.hasOwn(value, key);
const revision = (value) => typeof value === 'string' && /^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/.test(value);
const POLICY = 'plugins.entries.openclaw-code-agent.config.';
const safePaths = new Set(['tools.deny', `${POLICY}requiredGoalVerifierCommands`, `${POLICY}trustedVerifierCommands`]);
const scalar = (value) => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

export function configMethod(args) {
  const index = args.indexOf('gateway');
  const method = args[index + 2];
  return index >= 0 && args[index + 1] === 'call' && typeof method === 'string' && method.startsWith('config.') && method !== 'config.schema.lookup' ? method : undefined;
}
export function projectConfigRequest(method, params) {
  const result = { method, projection: true, fullRequestExcluded: true, originalParsedRequest: digest(JSON.stringify(params)) };
  if (revision(params.baseHash)) result.baseHash = params.baseHash;
  if (Array.isArray(params.replacePaths) && params.replacePaths.every((path) => safePaths.has(path))) result.replacePaths = [...params.replacePaths];
  if (method === 'config.patch' && typeof params.raw === 'string') {
    let raw; try { raw = JSON.parse(params.raw); } catch { return result; }
    const values = {};
    for (const path of result.replacePaths ?? []) {
      const value = path === 'tools.deny' ? raw.tools?.deny : raw.plugins?.entries?.['openclaw-code-agent']?.config?.[path.slice(POLICY.length)];
      // The fixed fixture policy commands and tool IDs are the only safe
      // request values. Arbitrary full-profile and unknown fields are excluded.
      if (scalar(value) || (Array.isArray(value) && value.every((entry) => typeof entry === 'string' && /^(?:agent_goal|bash (?:ci|lint|weak|fail)\.sh|true|false)$/.test(entry.trim())))) values[path] = value;
    }
    result.policyValues = values;
  }
  return result;
}
export function projectConfigResponse(method, response) {
  const result = { method, projection: true, rawFullResponseExcluded: true, originalParsedResponse: digest(JSON.stringify(response)) };
  if (typeof response.ok === 'boolean') result.ok = response.ok;
  for (const field of ['hash', 'configRevisionHash', 'appliedConfigHash']) if (revision(response[field])) result[field] = response[field];
  if (typeof response.valid === 'boolean') result.valid = response.valid;
  if (Array.isArray(response.changedPaths)) {
    result.changedPaths = response.changedPaths.filter((path) => safePaths.has(path));
    result.changedPathsExcludedCount = response.changedPaths.length - result.changedPaths.length;
  }
  const payload = response.sentinel?.payload;
  if (payload && ['config-patch', 'config-apply'].includes(payload.kind)) {
    result.sentinel = { persisted: response.sentinel.persisted === true, payload: { kind: payload.kind } };
    if (['ok', 'error'].includes(payload.status)) result.sentinel.payload.status = payload.status;
    if (Number.isFinite(payload.ts)) result.sentinel.payload.ts = payload.ts;
    if (['config.patch', 'config.apply'].includes(payload.stats?.mode)) {
      result.sentinel.payload.stats = { mode: payload.stats.mode };
      if (typeof payload.stats.requiresRestart === 'boolean') result.sentinel.payload.stats.requiresRestart = payload.stats.requiresRestart;
    }
  }
  return result;
}
export function projectConfigCommand(method, args, receipt) {
  const result = { projection: true, rawConfigStreamsAndArgumentsExcluded: true, method, exit: { code: receipt.exit.code, signal: receipt.exit.signal }, closeObserved: receipt.closeObserved, streamsComplete: receipt.streamsComplete, timedOut: receipt.timedOut,
    originalStdout: digest(receipt.stdout), originalStderr: digest(receipt.stderr), originalArguments: digest(JSON.stringify(args)),
    errors: receipt.errors.map((error) => ({ originalError: digest(String(error)) })) };
  if (receipt.exit.spawnError) result.exit.spawnError = { originalError: digest(String(receipt.exit.spawnError)) };
  const index = args.indexOf('--params');
  if (index >= 0) { try { result.request = projectConfigRequest(method, JSON.parse(args[index + 1])); } catch { result.requestParseFailed = true; } }
  try { result.response = projectConfigResponse(method, JSON.parse(receipt.stdout.slice(receipt.stdout.indexOf('{')))); } catch { result.responseParseFailed = true; }
  return result;
}
export function readOwnedConfig(path, directory) {
  assert.ok(isAbsolute(path) && isAbsolute(directory), 'Owned source uses absolute identities');
  const root = realpathSync(directory);
  assert.ok(root === resolve(directory), 'Owned root has no symlink identity');
  const lexical = relative(root, resolve(path));
  assert.ok(lexical && !lexical.startsWith('..') && !isAbsolute(lexical), 'Config input must belong to its owned root before reading');
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Owned config source must be regular');
  const actual = realpathSync(path), rel = relative(root, actual);
  assert.ok(actual === resolve(path) && rel && !rel.startsWith('..') && !isAbsolute(rel), 'Owned config source stays inside its profile without symlinks');
  const bytes = readFileSync(path);
  let config; try { config = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Owned internal config source cannot be parsed; raw source excluded'); }
  assert.ok(config && typeof config === 'object' && !Array.isArray(config) && !own(config, '$include'), 'No external owned-profile config include');
  return { config, bytes, sha256: digest(bytes).sha256, identity: { dev: stat.dev, ino: stat.ino } };
}
function accountView(config, { apiRoot, credential, publicReadback }) {
  const telegram = config?.channels?.telegram;
  assert.ok(telegram && telegram.enabled === true, 'Owned Telegram base account is enabled');
  assert.ok(!own(telegram, 'tokenFile') && !own(telegram, 'botTokenFile'), 'No external Telegram credential file');
  assert.ok(telegram.botToken === credential, publicReadback ? 'Pinned public credential is the official redaction sentinel' : 'Internal Telegram credential belongs to this fixture');
  assert.ok(telegram.apiRoot === apiRoot && new URL(apiRoot).hostname === '127.0.0.1', 'Telegram endpoint is the owned loopback fixture');
  assert.ok(telegram.dmPolicy === 'allowlist' && Array.isArray(telegram.allowFrom) && telegram.allowFrom.length === 1 && telegram.allowFrom[0] === '501002', 'Telegram destination authority is exact');
  assert.ok(!own(telegram, 'accounts') && !own(telegram, 'defaultAccount') && !own(telegram, 'defaultAccountId'), 'No alternative/default account override');
  assert.ok(Array.isArray(config.bindings) && config.bindings.length === 1, 'One authoritative channel binding');
  const binding = config.bindings[0];
  assert.ok(binding.agentId === 'main' && Object.keys(binding).length === 2 && binding.match?.channel === 'telegram' && binding.match?.accountId === 'default' && Object.keys(binding.match).length === 2, 'Exact main/default Telegram binding');
  return { provider: 'telegram', apiRoot, target: '501002', soleEffectiveAccount: 'default', binding: { agentId: 'main', channel: 'telegram', accountId: 'default' } };
}
export function telegramAuthority(response, { apiRoot, token, env, sourceConfig }) {
  assert.ok(env && !Object.keys(env).some((key) => /TELEGRAM/.test(key)), 'No inherited Telegram credential');
  assert.ok(revision(response.hash), 'Actual opaque raw revision identified');
  assert.ok(response.valid === true && revision(response.configRevisionHash) && revision(response.appliedConfigHash), 'Actual valid/applied resolved revisions identified');
  assert.ok(response.configRevisionHash === response.appliedConfigHash, 'Same-domain actual resolved runtime/source revisions agree');
  const publicView = accountView(response.config, { apiRoot, credential: '__OPENCLAW_REDACTED__', publicReadback: true });
  const ownedView = accountView(sourceConfig, { apiRoot, credential: token, publicReadback: false });
  assert.deepEqual(publicView, ownedView, 'Public and owned source authority agree');
  return { configHash: response.hash, configRevisionHash: response.configRevisionHash, appliedConfigHash: response.appliedConfigHash, ...publicView,
    credentialSourceVerified: true, credentialSource: 'official redacted readback + internal owned synthetic source; inherited Telegram credentials absent', projection: true, rawFullConfigExcluded: true };
}
export function assertStableAuthority(before, after, sourceBefore, sourceAfter, ownerBefore, ownerAfter) {
  assert.ok(before.hash === after.hash && before.configRevisionHash === after.configRevisionHash && before.appliedConfigHash === after.appliedConfigHash, 'Actual same-domain revision brackets stay stable');
  assert.ok(sourceBefore.bytes.equals(sourceAfter.bytes) && sourceBefore.sha256 === sourceAfter.sha256 && sourceBefore.identity.dev === sourceAfter.identity.dev && sourceBefore.identity.ino === sourceAfter.identity.ino, 'Owned source bytes and identity stay stable');
  assert.deepEqual(ownerBefore, ownerAfter, 'Owned Gateway process/profile stay stable');
}

export function exactFixtureRoute(route) {
  assert.ok(route && typeof route === 'object' && !Array.isArray(route), 'An actual route object is required');
  const keys = own(route, 'accountId') ? ['accountId', 'provider', 'target'] : ['provider', 'target'];
  assert.deepEqual(Object.keys(route).toSorted(), keys.toSorted(), 'No unobserved thread/alternate route');
  assert.ok(route.provider === 'telegram' && route.target === '501002', 'Exact Telegram destination');
  if (own(route, 'accountId')) assert.ok(route.accountId === 'default', 'Present account must be the exact configured default');
  return route;
}
export function sourceSendArgs(route, summary) {
  exactFixtureRoute(route);
  assert.ok(typeof summary === 'string' && summary.trim(), 'Nonempty source summary');
  return { action: 'send', channel: 'telegram', target: route.target, ...(own(route, 'accountId') ? { accountId: route.accountId } : {}), final: true, message: summary };
}

const routeMessageText = (entry) => typeof entry.content === "string" ? entry.content : (entry.content ?? []).map((part) => part.text ?? "").join("\n");
export function selectRoutedCompletion(input, goals) {
  assert.ok(Array.isArray(input.input));
  const index = input.input.findLastIndex((entry) => entry.role === "user" && !routeMessageText(entry).trim().startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"));
  if (index < 0 || !input.tools?.length) return;
  const wake = routeMessageText(input.input[index]);
  const lines = wake.split("\n").filter((line) => line.startsWith("originRoute: "));
  if (!lines.length) return;
  assert.equal(lines.length, 1, "Ambiguous current wake route");
  const route = JSON.parse(lines[0].slice("originRoute: ".length));
  if (route.provider === "webchat") return;
  exactFixtureRoute(route);
  assert.ok(wake.includes("use message(action='send', final=true) to originRoute"));
  const matching = goals.filter((goal) => ["succeeded", "failed", "stopped"].includes(goal.status) && wake.includes(`[${goal.name}] Goal task ${goal.name} ${goal.status}. ID: ${goal.sessionId}`));
  assert.equal(matching.length, 1, "Current routed completion selects exactly one actual goal/session");
  const goal = matching[0];
  const firstLine = wake.split("\n")[0].replace(/^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\] /, "");
  assert.equal(firstLine, `[${goal.name}] Goal task ${goal.name} ${goal.status}. ID: ${goal.sessionId}`, "Current completion must be the canonical wake, not a quoted recap");
  assert.ok(Object.keys(goal.route ?? {}).every((key) => ["provider", "target", "accountId", "sessionKey"].includes(key)), "No unobserved stored destination/thread");
  const storedRoute = { provider: goal.route?.provider, target: goal.route?.target, ...(goal.route && Object.hasOwn(goal.route, "accountId") ? { accountId: goal.route.accountId } : {}) };
  exactFixtureRoute(storedRoute);
  assert.deepEqual(route, storedRoute, "Task/wake account value and presence remain unchanged");
  return { goal, route, wake, index };
}
