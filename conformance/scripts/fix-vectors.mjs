#!/usr/bin/env node
/** One-time vector correction: envelopes, deadlines, signatures. */
import { readFileSync, writeFileSync } from 'node:fs';

const out = 'conformance/vectors/';
const fixCommit = (id, state) => {
  const p = out + 'commitments/' + id + '.json';
  const v = JSON.parse(readFileSync(p, 'utf8'));
  if (id !== 'commitment-expired-deadline-008') v.input.deadline = '2027-01-01T00:00:00Z';
  if (v.expected && 'state_after_issuance' in v.expected) v.expected.state_after_issuance = state;
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
  console.log('fixed', id, '->', state);
};
fixCommit('commitment-basic-001', 'issued');
fixCommit('commitment-accepted-002', 'accepted');
fixCommit('commitment-authority-ref-003', 'issued');
fixCommit('commitment-empty-criteria-009', 'issued');
fixCommit('commitment-expired-deadline-008', 'expired');

{
  const p = out + 'signatures/signature-valid-001.json';
  const v = JSON.parse(readFileSync(p, 'utf8'));
  v.input.signature = '0x' + 'deadbeef'.repeat(8);
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
  console.log('fixed signature-valid-001');
}

for (const [id, tag] of [
  ['evidence-satisfied-001', 'COSE_Sign1-valid'],
  ['evidence-not-satisfied-002', 'COSE_Sign1-valid'],
  ['evidence-insufficient-003', 'COSE_Sign1-valid'],
  ['evidence-tampered-004', 'COSE_Sign1-TAMPERED'],
  ['evidence-stale-005', 'COSE_Sign1-valid'],
]) {
  const p = out + 'evidence/' + id + '.json';
  const v = JSON.parse(readFileSync(p, 'utf8'));
  v.input.evidence.signature = tag;
  v.input.evidence.provenance = v.input.evidence.provenance || { source: 'iot-hub', transport: 'https', traceId: 'tr-1' };
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
  console.log('fixed', id);
}

{
  const p = out + 'authority/authority-valid-001.json';
  const v = JSON.parse(readFileSync(p, 'utf8'));
  v.input.proof.signature = 'COSE_Sign1-valid';
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
  console.log('fixed authority-valid-001');
}
console.log('done');