// Offline formatting/presentation controls; no native/host acceptance evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hostLogEvidence } from './oca501-lifecycle-protocol.mjs';
import { pinnedFileMessage, serializeHostLogArtifact, presentHostLogDiagnostic, HOST_DIAGNOSTIC_IDENTITIES, hostLogArtifactPlan } from './oca501-host-log-projection.mjs';
const started=performance.now(), sha=x=>createHash('sha256').update(x).digest('hex');
const compact=v=>serializeHostLogArtifact(v,undefined,undefined,{compact:true});
const wrapper=d=>compact({rejectedStreamDiagnostic:d,sourceIdentity:'runtime.log',guardSource:{candidateSha:'a'.repeat(40),helperSha256:'b'.repeat(64)}});
let groups=0,negativeControls=0;
const value={a:[null,false,0,'Harmless UTF8 é text'],nested:{scope:'same fields and values'}};
assert.deepEqual(JSON.parse(compact(value)),JSON.parse(serializeHostLogArtifact(value)));assert.ok(compact(value).endsWith('\n'));groups++;
const authority={candidateSha:'a'.repeat(40),helperSha256:'b'.repeat(64),hostCommit:'c074824a27c96d3983043f9eeb33823cd1772d8c',agentIds:[],sessionIds:[],channels:[],responsesStarts:[]};
const logger=p=>{const r={'0':p,_meta:{logLevelId:2,logLevelName:'DEBUG'}};r.message=pinnedFileMessage(r);return r;};
const raw=Buffer.from([...Array.from({length:14},()=>logger({message:'Safe text'})),...Array.from({length:21},()=>logger({unknown:'SYNTHETIC_PRIVATE_VALUE'}))].map(JSON.stringify).join('\n'));
const before=Buffer.from(raw),r=hostLogEvidence(raw,{sourceAuthority:authority});
assert.deepEqual(raw,before);assert.equal(r.original.sha256,sha(raw));assert.equal(r.sourceProjectionAttempt.observations.projectedRecords,14);assert.equal(r.sourceProjectionAttempt.observations.blockedRecords,21);
const d=r.rejectedStreamDiagnostic;assert.equal(d.failedLines,35);assert.equal(d.failedLineDetails.length,35);assert.deepEqual(d.failedLineDetails.map(x=>x.line),Array.from({length:35},(_,i)=>i));
assert.ok(!JSON.stringify(d).includes('SYNTHETIC_PRIVATE_VALUE'));groups++;negativeControls++;
const plan=hostLogArtifactPlan('runtime.log',r,raw.toString('utf8'),{serialize:serializeHostLogArtifact,compactSerialize:compact,redact:x=>x,guardSource:{candidateSha:authority.candidateSha},assertProjectedSafe:()=>{throw Error('unexpected');}});
assert.equal(plan.blocked,true);assert.ok(Buffer.byteLength(wrapper(plan.receipt.rejectedStreamDiagnostic))<=65536);assert.equal(plan.receipt.rejectedStreamDiagnostic.failedLineDetails.length,35);assert.deepEqual(JSON.parse(plan.files[0].text).rejectedStreamDiagnostic,JSON.parse(JSON.stringify(d)));groups++;
// Force a genuine detail-presentation bound with closed synthetic observations.
const large={...d,failedLineDetails:d.failedLineDetails.map(x=>({...x,sourceObservation:{status:'OFFLINE_CLOSED_OBSERVATION',nodes:Array.from({length:100},()=>({type:'OBJECT',knownFields:{STRING:['component','event']},unknownFieldCount:0}))}}))};
large[HOST_DIAGNOSTIC_IDENTITIES]=d[HOST_DIAGNOSTIC_IDENTITIES];
const selected=presentHostLogDiagnostic(large,wrapper);
assert.ok(Buffer.byteLength(wrapper(selected))<=65536);assert.equal(selected.failedLines,35);assert.equal(selected.rawFailureRecordIdentities.length,35);assert.equal(selected.sourceBlockedRecordIndices.length,21);assert.equal(selected.inspectionComplete,d.inspectionComplete);assert.equal(selected.presentationComplete,false);
assert.ok(selected.failedLineDetails.every(x=>selected.sourceBlockedRecordIndices.includes(x.line)));assert.equal(selected.omittedFailedLineDetails,35-selected.failedLineDetails.length);groups++;negativeControls++;
// A single detail cannot fit: retain identity/counts, never truncate it.
const huge={...large,failedLineDetails:[{...large.failedLineDetails[0],sourceObservation:{status:'OFFLINE_BOUND',nodes:Array.from({length:10000},()=>({type:'OBJECT',knownFields:{STRING:['component']}}))}}]};huge[HOST_DIAGNOSTIC_IDENTITIES]=large[HOST_DIAGNOSTIC_IDENTITIES];
const noDetail=presentHostLogDiagnostic(huge,wrapper);assert.equal(noDetail.failedLineDetails.length,0);assert.equal(noDetail.omittedFailedLineDetails,35);assert.equal(noDetail.rawFailureRecordIdentities.length,35);assert.ok(Buffer.byteLength(wrapper(noDetail))<=65536);groups++;negativeControls++;
const summaryHuge={...huge};summaryHuge[HOST_DIAGNOSTIC_IDENTITIES]={identities:Array.from({length:10000},()=>d[HOST_DIAGNOSTIC_IDENTITIES].identities[0]),sourceBlockedIndices:Array.from({length:10000},(_,i)=>i)};
const fallback=presentHostLogDiagnostic(summaryHuge,wrapper);assert.equal(fallback.diagnosticStatus,'DIAGNOSTIC_OUTPUT_BOUND_EXCEEDED');assert.equal(fallback.omittedFailedLineDetails,35);assert.equal(fallback.inspectionComplete,false);assert.ok(Buffer.byteLength(wrapper(fallback))<=65536);groups++;negativeControls++;
const expanded=presentHostLogDiagnostic(large,x=>wrapper(x).replaceAll('OFFLINE_CLOSED_OBSERVATION','Bounded redaction '.repeat(1000)));assert.ok(Buffer.byteLength(wrapper(expanded).replaceAll('OFFLINE_CLOSED_OBSERVATION','Bounded redaction '.repeat(1000)))<=65536);assert.equal(expanded.failedLines,35);groups++;negativeControls++;
console.log(JSON.stringify({scope:'OFFLINE_COMPACT_LOG_DIAGNOSTIC_ONLY',positiveGroups:groups,negativeControls,actualCompleteWrapperBytes:Buffer.byteLength(wrapper(d)),actualPrioritizedWrapperBytes:Buffer.byteLength(wrapper(selected)),retainedSourceBlockedDetails:selected.failedLineDetails.length,elapsedMs:performance.now()-started}));
