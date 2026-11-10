// Phase D4B runtime environment-boundary probe (child side).
//
// Spawned as a REAL child process by the D4B suite with the EXACT env the
// supervisor builds for the entry-point class it stands in for (API child,
// synthetic signer, worker). It reports only the NAMES of the candidate
// secret variables that are present in its environment, then exits. It never
// prints values.
//
// Usage: node scripts/_env-probe-child.cjs <comma-separated candidate names>
// Output: a single line "ENVREPORT <json>" where json = { present: [names] }.
'use strict';
const candidates = String(process.argv[2] || '').split(',').filter(Boolean);
const present = candidates.filter((k) => process.env[k] !== undefined);
console.log('ENVREPORT ' + JSON.stringify({ present }));
process.exit(0);
