// Offline config-export/route assertion controls; no host/backend simulation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configMethod, projectConfigCommand, projectConfigRequest, projectConfigResponse, telegramAuthority, exactFixtureRoute, sourceSendArgs, selectRoutedCompletion, readOwnedConfig, assertStableAuthority, actualToolPayload, assertActualSendResult } from './oca501-config-receipt.mjs';
import { buildEvidence, frameEvidence, decodeEvidence } from './oca501-evidence.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hidden = 'PRIVATE_UNKNOWN_PROFILE_SENTINEL';
const h = `hmac-sha256:v1:${'a'.repeat(43)}`, apiRoot = 'http://127.0.0.1:51111', token = 'OWNED_SYNTHETIC_TOKEN';
const config = { gateway: { secret: hidden }, unknown: hidden, agents: { private: hidden }, providers: { private: hidden }, channels: { telegram: { enabled: true, botToken: token, apiRoot, dmPolicy: 'allowlist', allowFrom: ['501002'], replyToMode: 'off' } }, bindings: [{ agentId: 'main', match: { channel: 'telegram', accountId: 'default' } }] };
const publicConfig = structuredClone(config); publicConfig.channels.telegram.botToken = '__OPENCLAW_REDACTED__';
const resolved = `hmac-sha256:v1:${'b'.repeat(43)}`;
const response = { ok: true, hash: h, valid: true, configRevisionHash: resolved, appliedConfigHash: resolved, config: publicConfig, raw: hidden, errors: hidden, changedPaths: ['tools.deny', hidden], sentinel: { persisted: true, payload: { kind: 'config-patch', status: 'ok', ts: 1, message: hidden, doctorHint: hidden, stats: { mode: 'config.patch', root: hidden, requiresRestart: false, private: hidden } } } };
const raw = JSON.stringify({ tools: { deny: ['agent_goal'] }, gateway: { secret: hidden } });
const params = { raw, baseHash: h, replacePaths: ['tools.deny'], private: hidden };
const args = ['official-entry', 'gateway', 'call', 'config.patch', '--params', JSON.stringify(params), '--json'];
const stdout = JSON.stringify(response), stderr = `Failure detail: ${hidden}`;
const receipt = { stdout, stderr, exit: { code: 0, signal: null }, streamsComplete: true, closeObserved: true, timedOut: false, errors: [] };
const projection = projectConfigCommand('config.patch', args, receipt);
assert.equal(configMethod(args), 'config.patch');
assert.equal(configMethod(['official-entry', 'gateway', 'call', 'config.schema.lookup']), undefined);
assert.equal(projection.originalStdout.bytes, Buffer.byteLength(stdout)); assert.equal(projection.originalStdout.sha256, hash(stdout));
assert.equal(projection.originalStderr.sha256, hash(stderr)); assert.equal(projection.originalArguments.sha256, hash(JSON.stringify(args)));
assert.equal(projection.response.originalParsedResponse.sha256, hash(JSON.stringify(response)));
assert.deepEqual(projection.request.policyValues, { 'tools.deny': ['agent_goal'] });
assert.equal(projection.response.hash, h); assert.deepEqual(projection.response.changedPaths, ['tools.deny']); assert.equal(projection.response.changedPathsExcludedCount, 1); assert.equal(projection.response.sentinel.payload.stats.requiresRestart, false);
const dedicated = { beforeHash: h, request: projectConfigRequest('config.patch', params), result: projectConfigResponse('config.patch', response) };
assert.equal(response.config, publicConfig, 'Actual internal full readback is neither replaced nor mutated');
assert.equal(response.config.gateway.secret, hidden);
const failure = projectConfigCommand('config.apply', ['official-entry', 'gateway', 'call', 'config.apply', '--params', JSON.stringify({ raw: JSON.stringify(config), private: hidden })], { ...receipt, stdout: `invalid profile ${hidden}`, exit: { code: 1, signal: null, spawnError: hidden }, errors: [hidden] });
assert.equal(failure.exit.code, 1); assert.equal(failure.responseParseFailed, true);
assert.equal(failure.originalStdout.sha256, hash(`invalid profile ${hidden}`));
const authorityOptions = { apiRoot, token, env: { PATH: '/owned' }, sourceConfig: config };
const authority = telegramAuthority(response, authorityOptions);
assert.equal(authority.soleEffectiveAccount, 'default'); assert.equal(authority.configHash, h);
for (const exported of [projection, dedicated, failure, authority, projectConfigCommand('config.get', ['gateway', 'call', 'config.get'], receipt), projectConfigRequest('config.apply', { raw: JSON.stringify(config) })]) {
  assert.ok(!JSON.stringify(exported).includes(hidden)); assert.ok(!JSON.stringify(exported).includes(token));
  assert.equal(Object.hasOwn(exported, 'stdout'), false); assert.equal(Object.hasOwn(exported, 'stderr'), false); assert.equal(Object.hasOwn(exported, 'args'), false);
}
const negatives = [];
const deny = (name, action) => { assert.throws(action, undefined, name); negatives.push(name); };
for (const [name, mutate] of [
  ['foreign credential', (copy) => { copy.channels.telegram.botToken = 'foreign'; }],
  ['external credential file', (copy) => { copy.channels.telegram.tokenFile = '/foreign'; }],
  ['alternate accounts', (copy) => { copy.channels.telegram.accounts = { other: {} }; }],
  ['default override', (copy) => { copy.channels.telegram.defaultAccount = 'other'; }],
  ['wrong endpoint', (copy) => { copy.channels.telegram.apiRoot = 'http://external'; }],
  ['wrong allowlist', (copy) => { copy.channels.telegram.allowFrom.push('other'); }],
  ['alternate binding', (copy) => { copy.bindings.push({ agentId: 'other' }); }],
  ['binding account mismatch', (copy) => { copy.bindings[0].match.accountId = 'other'; }],
]) { const copy = structuredClone(publicConfig); mutate(copy); deny(name, () => telegramAuthority({ ...response, config: copy }, authorityOptions)); }
deny('inherited Telegram credential', () => telegramAuthority(response, { ...authorityOptions, env: { TELEGRAM_BOT_TOKEN: token } }));
for (const [name, changed] of [
  ['legacy 64hex revision', { hash: 'a'.repeat(64) }], ['malformed revision', { hash: 'malformed' }], ['missing resolved revision', { configRevisionHash: undefined }],
  ['applied/source mismatch', { appliedConfigHash: `hmac-sha256:v1:${'c'.repeat(43)}` }], ['raw/resolved cross-domain mistake', { appliedConfigHash: h }], ['invalid public config', { valid: false }],
]) deny(name, () => telegramAuthority({ ...response, ...changed }, authorityOptions));
for (const [name, mutate] of [
  ['wrong owned credential', (copy) => { copy.channels.telegram.botToken = 'foreign'; }], ['owned credential file', (copy) => { copy.channels.telegram.tokenFile = '/foreign'; }],
  ['owned alternate accounts', (copy) => { copy.channels.telegram.accounts = {}; }], ['owned default override', (copy) => { copy.channels.telegram.defaultAccount = 'other'; }],
  ['owned endpoint mismatch', (copy) => { copy.channels.telegram.apiRoot = 'http://127.0.0.1:52222'; }], ['owned target mismatch', (copy) => { copy.channels.telegram.allowFrom = ['other']; }],
  ['owned binding mismatch', (copy) => { copy.bindings[0].agentId = 'other'; }],
]) { const copy = structuredClone(config); mutate(copy); deny(name, () => telegramAuthority(response, { ...authorityOptions, sourceConfig: copy })); }
for (const mode of [undefined, 'all', 'first', null, false, '', 'foreign']) {
  for (const boundary of ['public', 'owned']) {
    const copy = structuredClone(boundary === 'public' ? publicConfig : config);
    if (mode === undefined) delete copy.channels.telegram.replyToMode; else copy.channels.telegram.replyToMode = mode;
    deny(`${boundary} reply mode ${String(mode)}`, () => telegramAuthority(boundary === 'public' ? { ...response, config: copy } : response, boundary === 'owned' ? { ...authorityOptions, sourceConfig: copy } : authorityOptions));
  }
}
const ownedRoot = mkdtempSync(join(tmpdir(), 'oca501-authority-controls-'));
const sourcePath = join(ownedRoot, 'config.json'); writeFileSync(sourcePath, JSON.stringify(config));
const source = readOwnedConfig(sourcePath, ownedRoot);
const owner = { pid: 501, startTicks: 'control-only', profile: 'offline fixture' };
assertStableAuthority(response, structuredClone(response), source, readOwnedConfig(sourcePath, ownedRoot), owner, structuredClone(owner));
deny('unstable public revision bracket', () => assertStableAuthority(response, { ...response, hash: `hmac-sha256:v1:${'c'.repeat(43)}` }, source, source, owner, owner));
deny('unstable owned source bytes', () => assertStableAuthority(response, response, source, { ...source, bytes: Buffer.from('changed') }, owner, owner));
deny('changed owned source identity', () => assertStableAuthority(response, response, source, { ...source, identity: { ...source.identity, ino: source.identity.ino + 1 } }, owner, owner));
deny('changed process instance', () => assertStableAuthority(response, response, source, source, owner, { ...owner, startTicks: 'different' }));
const outside = mkdtempSync(join(tmpdir(), 'oca501-outside-controls-')); const outsidePath = join(outside, 'config.json'); writeFileSync(outsidePath, '{}');
deny('outside source', () => readOwnedConfig(outsidePath, ownedRoot));
symlinkSync(sourcePath, join(ownedRoot, 'linked.json')); deny('symlink source', () => readOwnedConfig(join(ownedRoot, 'linked.json'), ownedRoot));
writeFileSync(join(ownedRoot, 'include.json'), JSON.stringify({ ...config, $include: 'foreign.json' })); deny('external include source', () => readOwnedConfig(join(ownedRoot, 'include.json'), ownedRoot));
const routes = [{ provider: 'telegram', target: '501002', accountId: 'default' }, { provider: 'telegram', target: '501002' }];
const goalFor = (route) => ({ id: 'control-goal', name: 'control', sessionId: 'actual-control-session', status: 'succeeded', route: { ...route, sessionKey: 'origin-control' } });
const inputFor = (route) => ({ tools: [{ name: 'tool_search' }], input: [{ role: 'user', content: `[control] Goal task control succeeded. ID: actual-control-session\noriginRoute: ${JSON.stringify(route)}\nuse message(action='send', final=true) to originRoute` }] });
for (const route of routes) {
  const selected = selectRoutedCompletion(inputFor(route), [goalFor(route)]);
  assert.deepEqual(selected.route, route); const sent = sourceSendArgs(selected.route, 'Actual control summary');
  assert.equal(Object.hasOwn(sent, 'accountId'), Object.hasOwn(route, 'accountId'));
}
for (const accountId of [undefined, null, '', ' ', 2, false, 'foreign']) deny(`malformed present account ${String(accountId)}`, () => exactFixtureRoute({ ...routes[1], accountId }));
for (const [name, route] of [['foreign target', { ...routes[1], target: 'other' }], ['foreign provider', { ...routes[1], provider: 'other' }], ['unobserved thread', { ...routes[1], threadId: 2 }]]) deny(name, () => selectRoutedCompletion(inputFor(route), [goalFor(route)]));
for (const route of routes) deny('task/wake field-presence mismatch', () => selectRoutedCompletion(inputFor(route), [goalFor(routes.find((other) => other !== route))]));
const input = inputFor(routes[0]);
deny('duplicate route line', () => selectRoutedCompletion({ ...input, input: [{ ...input.input[0], content: `${input.input[0].content}\noriginRoute: {}` }] }, [goalFor(routes[0])]));
assert.equal(selectRoutedCompletion({ ...input, input: [...input.input, { role: 'user', content: 'New unrelated request' }] }, [goalFor(routes[0])]), undefined);
assert.equal(selectRoutedCompletion({ ...input, tools: [] }, [goalFor(routes[0])]), undefined);
for (const prefix of ['Quoted recap:\n', '```\n', '> ']) deny('quoted/fenced wake', () => selectRoutedCompletion({ ...input, input: [{ ...input.input[0], content: prefix + input.input[0].content }] }, [goalFor(routes[0])]));
deny('stored unobserved thread', () => selectRoutedCompletion(input, [goalFor({ ...routes[0], threadId: 2 })]));
const timestamped = { ...input, input: [{ ...input.input[0], content: '[Fri 2026-10-02 00:35 UTC] ' + input.input[0].content }] };
assert.equal(selectRoutedCompletion(timestamped, [goalFor(routes[0])]).goal.id, 'control-goal');
// Captured genuine R4 union (safe fixture-only call/cause), not an E2E
// simulation. Receipt persistence precedes interpretation; zero success paths.
const originalCause = 'ToolInputError: replyTo must be a positive integer.';
const actualError = { type: 'function_call_output', call_id: 'call_oca501_parent_23', output: JSON.stringify({ status: 'error', tool: 'tool_call', error: originalCause }) };
const matchedReceipts = []; let sourceSuccesses = 0, silentSuccesses = 0;
const interpret = (entry) => {
  matchedReceipts.push(structuredClone(entry));
  const payload = actualToolPayload(entry);
  assertActualSendResult(payload, 'tool_call', { id: 'actual-message' }, entry.call_id);
  sourceSuccesses++; silentSuccesses++;
};
assert.throws(() => interpret(actualError), (error) => error.message.includes(originalCause) && error.message.includes(actualError.call_id));
assert.deepEqual(matchedReceipts[0], actualError); assert.equal(sourceSuccesses, 0); assert.equal(silentSuccesses, 0);
negatives.push('captured R4 status-error retained before interpretation with no source/silent success');
for (const wrapper of [{ isError: true, error: originalCause }, { tool: {}, result: { status: 'error', error: originalCause } }, { tool: {}, result: { isError: true, error: originalCause } }, { tool: {}, result: { details: { error: originalCause } } }]) {
  deny('actual-shaped nested host error cause', () => actualToolPayload({ ...actualError, output: JSON.stringify(wrapper) }));
}
for (const payload of [null, [], { status: 'pending' }, { tool: 'tool_call' }, { tool: { id: 'actual-message', name: 'message', source: 'openclaw' }, result: {} }]) deny('unknown/malformed send union', () => assertActualSendResult(payload, 'tool_call', { id: 'actual-message' }, actualError.call_id));
const success = { tool: { id: 'actual-message', name: 'message', source: 'openclaw' }, result: { content: [{ type: 'text', text: 'Actual-shape result' }], details: { ok: true } } };
assertActualSendResult(actualToolPayload({ ...actualError, output: JSON.stringify(success) }), 'tool_call', { id: 'actual-message' }, actualError.call_id);
assertActualSendResult({ ok: true, messageId: 'actual-shape' }, 'message', undefined, actualError.call_id);
// Exercise registration + the actual evidence encoder/decoder boundary with
// projected receipts. No raw config inputs are written to artifact files.
const directory = mkdtempSync(join(tmpdir(), 'oca501-config-controls-'));
for (const [name, value] of Object.entries({ 'command.json': projection, 'dedicated.json': dedicated, 'failure.json': failure, 'authority.json': authority })) writeFileSync(join(directory, name), JSON.stringify(value));
const metadata = { candidateSha: 'a'.repeat(40), nodeVersion: '24.16.0', phase: 'controls-only', scriptExitCode: 1, primaryFailure: 'original failure', cleanup: { classification: 'PASS', failures: [] } };
const bundle = buildEvidence(directory, ['command.json', 'dedicated.json', 'failure.json', 'authority.json'].map((name) => ({ name, alreadyRedacted: true })), metadata, [token]);
const decoded = decodeEvidence(frameEvidence(bundle), { candidateSha: metadata.candidateSha, nodeVersion: metadata.nodeVersion, phase: metadata.phase, controlsOnly: true });
assert.ok(decoded.files.every((file) => !file.content.includes(hidden) && !file.content.includes(token)));
console.log(JSON.stringify({ scope: 'Offline route/config projection enforcement controls only', positiveGroups: 8, negativeCount: negatives.length, negatives, scratch: directory }));
