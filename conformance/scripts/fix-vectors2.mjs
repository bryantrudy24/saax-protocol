#!/usr/bin/env node
/** Vector fix pass 2: policy criterionId + future-proof validity windows. */
import { readFileSync, writeFileSync } from 'node:fs';

const out = 'conformance/vectors/';
for (const id of ['evidence-satisfied-001', 'evidence-not-satisfied-002', 'evidence-insufficient-003', 'evidence-tampered-004', 'evidence-stale-005']) {
  const p = out + 'evidence/' + id + '.json';
  const v = JSON.parse(readFileSync(p, 'utf8'));
  if (!v.input.criterion.criterionId) v.input.criterion.criterionId = 'c1';
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
  console.log('fixed criterionId', id);
}
for (const id of ['authority-valid-001']) {
  const p = out + 'authority/' + id + '.json';
  const v = JSON.parse(readFileSync(p, 'utf8'));
  v.input.proof.validUntil = '2027-12-31T00:00:00Z';
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
  console.log('fixed validity', id);
}
console.log('done');