// Offline internal setup branch controls; never Gateway/policy-epoch evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ensureSuiteFields } from './oca501-config-receipt.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rawRevision = `hmac-sha256:v1:${'a'.repeat(43)}`, nextRevision = `hmac-sha256:v1:${'c'.repeat(43)}`, resolved = `hmac-sha256:v1:${'b'.repeat(43)}`;
const A = ['bash ci.sh', 'bash lint.sh', 'bash ci.sh'];
const fields = (commands = A, trusted = []) => ({ ...(commands !== undefined ? { requiredGoalVerifierCommands: commands } : {}), trustedVerifierCommands: trusted });
const snapshot = (authored) => {
  const config = { plugins: { entries: { 'openclaw-code-agent': { config: structuredClone(authored) } } }, unknownPrivateProfile: 'PRIVATE_SOURCE_NOT_EXPORTABLE' };
  const bytes = Buffer.from(JSON.stringify(config));
  return { public: { valid: true, hash: rawRevision, configRevisionHash: resolved, appliedConfigHash: resolved, config: structuredClone(config) }, source: { config, bytes, sha256: sha(bytes), identity: { dev: 1, ino: 2 } }, owner: { pid: 123, executable: '/owned/node', startTicks: '123', listenerPort: 51111, profile: { HOME: '/owned/home' }, installedEntryHash: 'f'.repeat(64) } };
};
const clone = (input) => { const copy = structuredClone(input); copy.source.bytes = Buffer.from(input.source.bytes); return copy; };
const negatives = [], deny = async (label, action) => { await assert.rejects(action, undefined, label); negatives.push(label); };
async function exercise({ commands = A, trusted = [], authored = fields(), changeBefore, changeAfter, changeAck } = {}) {
  let current = snapshot(authored), patchCalls = 0, patchCounter = 0; const observed = [];
  const result = await ensureSuiteFields({ commands, trusted, observe: async (position) => {
    observed.push(position); const actual = clone(current); if (position === 'before' && changeBefore) changeBefore(actual); if (position === 'after' && changeAfter) changeAfter(actual); return actual;
  }, patch: async (raw, paths) => {
    patchCalls++; patchCounter++;
    assert.deepEqual(paths, ['plugins.entries.openclaw-code-agent.config.requiredGoalVerifierCommands', 'plugins.entries.openclaw-code-agent.config.trustedVerifierCommands']);
    const desired = raw.plugins.entries['openclaw-code-agent'].config;
    assert.equal(Object.hasOwn(desired, 'requiredGoalVerifierCommands'), true);
    const next = { ...(desired.requiredGoalVerifierCommands !== null ? { requiredGoalVerifierCommands: desired.requiredGoalVerifierCommands } : {}), trustedVerifierCommands: desired.trustedVerifierCommands };
    current = snapshot(next); current.public.hash = nextRevision;
    const ack = { ok: true, hash: nextRevision, changedPaths: paths, sentinel: { payload: { stats: { requiresRestart: false } } } }; if (changeAck) changeAck(ack); return ack;
  } });
  assert.deepEqual(observed, ['before', 'after']); assert.ok(!JSON.stringify(result).includes('PRIVATE_SOURCE_NOT_EXPORTABLE'));
  return { result, patchCalls, patchCounter };
}
const equal = await exercise(); assert.equal(equal.patchCalls, 0); assert.equal(equal.patchCounter, 0); assert.equal(equal.result.classification, 'ALREADY_SET_READBACK_ONLY'); assert.equal(equal.result.mutation, false); assert.equal(equal.result.policyTransitionEvidence, false); assert.equal(Object.hasOwn(equal.result, 'mutationAck'), false);
// Undefined is intentionally passed directly: default-parameter destructuring
// would turn the requested absence into A in the convenience exercise helper.
let absenceMutations = 0; const absent = snapshot({ trustedVerifierCommands: [] });
const absentReceipt = await ensureSuiteFields({ commands: undefined, trusted: [], observe: async () => clone(absent), patch: async () => { absenceMutations++; assert.fail('Exact absent source cannot mutate'); } });
assert.equal(absenceMutations, 0); assert.equal(absentReceipt.requestedFieldPresence.requiredGoalVerifierCommands, false);
for (const authored of [
  { requiredGoalVerifierCommands: A }, fields(['bash ci.sh']), fields(['bash ci.sh', 'bash ci.sh', 'bash lint.sh']), fields([' bash ci.sh ', 'bash lint.sh', 'bash ci.sh']),
  fields(A, ['bash weak.sh']), fields(null), fields([]), fields(['']), fields(['bash ci.sh', 1]),
]) { const changed = await exercise({ authored }); assert.equal(changed.patchCalls, 1); assert.equal(changed.result.classification, 'APPLIED_SOURCE_CHANGE'); assert.equal(changed.result.acceptedMutationAckEvidence, true); assert.equal(changed.result.policyTransitionEvidence, false); }
let removalCalls = 0, removalSource = snapshot(fields());
const removed = await ensureSuiteFields({ commands: undefined, trusted: [], observe: async () => clone(removalSource), patch: async (raw, paths) => {
  removalCalls++; assert.equal(raw.plugins.entries['openclaw-code-agent'].config.requiredGoalVerifierCommands, null);
  removalSource = snapshot({ trustedVerifierCommands: [] }); removalSource.public.hash = nextRevision;
  return { ok: true, hash: nextRevision, changedPaths: paths, sentinel: { payload: { stats: { requiresRestart: false } } } };
} });
assert.equal(removalCalls, 1); assert.equal(removed.requestedFieldPresence.requiredGoalVerifierCommands, false);
for (const commands of [null, [], [''], [' '], ['bash ci.sh', 1], 'bash ci.sh']) {
  let observations = 0; await deny('malformed/null/empty internal setup cannot become absence', () => ensureSuiteFields({ commands, observe: async () => { observations++; return clone(absent); }, patch: async () => assert.fail() })); assert.equal(observations, 0);
}
for (const trusted of [null, [''], ['bash weak.sh', false], 'bash weak.sh']) await deny('malformed trusted setup is not silently defaulted', () => ensureSuiteFields({ commands: A, trusted, observe: async () => clone(absent), patch: async () => assert.fail() }));
for (const changeAfter of [
  (s) => { s.public.valid = false; }, (s) => { s.public.hash = 'a'.repeat(64); }, (s) => { s.public.hash = nextRevision; },
  (s) => { s.public.configRevisionHash = nextRevision; }, (s) => { s.public.appliedConfigHash = nextRevision; },
  (s) => { s.public.configRevisionHash = nextRevision; s.public.appliedConfigHash = nextRevision; },
  (s) => { s.source.bytes = Buffer.from('different owned bytes'); s.source.sha256 = sha(s.source.bytes); },
  (s) => { s.source.identity.ino++; }, (s) => { s.owner.startTicks = 'foreign'; },
  (s) => { s.public.config.plugins.entries['openclaw-code-agent'].config.trustedVerifierCommands = ['bash weak.sh']; },
  (s) => { delete s.public.config.plugins.entries['openclaw-code-agent'].config.requiredGoalVerifierCommands; },
]) await deny('readback-only requires exact public/source/valid/applied/process brackets', () => exercise({ changeAfter }));
for (const changeBefore of [
  (s) => { s.public.valid = false; }, (s) => { s.public.appliedConfigHash = nextRevision; },
  (s) => { s.public.config.plugins.entries['openclaw-code-agent'].config.trustedVerifierCommands = ['bash weak.sh']; },
  (s) => { s.public.config.plugins.entries['openclaw-code-agent'].config.requiredGoalVerifierCommands = ['PRIVATE_SOURCE_NOT_EXPORTABLE']; },
]) {
  await deny('initial public/owned disagreement is not readback-only proof', async () => {
    try { await exercise({ changeBefore }); } catch (error) { assert.ok(!String(error).includes('PRIVATE_SOURCE_NOT_EXPORTABLE')); throw error; }
  });
}
for (const changeAck of [
  (ack) => { ack.ok = false; }, (ack) => { ack.hash = rawRevision; }, (ack) => { ack.changedPaths = []; },
  (ack) => { ack.sentinel.payload.stats.requiresRestart = true; }, (ack) => { ack.hash = `hmac-sha256:v1:${'d'.repeat(43)}`; },
]) await deny('real-change branch cannot accept no-op/bad ACK/restart/readback mismatch', () => exercise({ authored: fields(['bash lint.sh']), changeAck }));
console.log(JSON.stringify({ classification: 'OFFLINE_SUITE_SETUP_BRANCH_CONTROLS_ONLY', positiveGroups: 5, negativeCount: negatives.length, negatives }));
