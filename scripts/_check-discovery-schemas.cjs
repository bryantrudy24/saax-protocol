// Phase-1 schema proof: validate spec/examples/discovery/*.json against the
// four JSON Schemas using the maintained ajv (2020-12 dialect, in repo deps).
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const SCHEMAS = {
  'extension-params.schema.json': 'https://saax-protocol.com/schemas/discovery/extension-params/v1',
  'profile.schema.json': 'https://saax-protocol.com/schemas/discovery/profile/v1',
  'prepare-request.schema.json': 'https://saax-protocol.com/schemas/discovery/prepare-request/v1',
  'proposal.schema.json': 'https://saax-protocol.com/schemas/discovery/proposal/v1',
  'acceptance.schema.json': 'https://saax-protocol.com/schemas/discovery/acceptance/v1',
};

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);

const schemaDir = path.join(__dirname, '..', 'spec', 'schemas', 'discovery');
const loaded = {};
for (const [file, id] of Object.entries(SCHEMAS)) {
  const s = JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
  if (s.$id !== id) throw new Error(file + ': $id mismatch ' + s.$id + ' != ' + id);
  loaded[file] = ajv.compile(s);
  console.log('[schema ok] ' + file + ' (' + id + ')');
}

// Route each example to the schema that governs it by filename.
function schemaFor(fname) {
  if (fname.startsWith('extension-')) return loaded['extension-params.schema.json'];
  if (fname.startsWith('profile-')) return loaded['profile.schema.json'];
  if (fname.startsWith('prepare-request-')) return loaded['prepare-request.schema.json'];
  if (fname.startsWith('proposal-')) return loaded['proposal.schema.json'];
  if (fname.startsWith('acceptance-')) return loaded['acceptance.schema.json'];
  if (fname.startsWith('buyer-registry-')) return null; // config, no schema
  if (fname.startsWith('retrieval-')) return null; // policy-only, no schema
  return null;
}

const exDir = path.join(__dirname, '..', 'spec', 'examples', 'discovery');
let pass = 0, fail = 0;
for (const f of fs.readdirSync(exDir).filter(x => x.endsWith('.json'))) {
  const validate = schemaFor(f);
  if (!validate) { console.log('[skip] ' + f + ' (no governing schema)'); continue; }
  const doc = JSON.parse(fs.readFileSync(path.join(exDir, f), 'utf8'));
  const ok = validate(doc);
  const expectValid = !/^.*-invalid-/.test(f);
  const verdict = (ok === expectValid) ? 'PASS' : 'FAIL';
  if (verdict === 'PASS') pass++; else { fail++; console.log('[' + verdict + '] ' + f + ' expected valid=' + expectValid + ' got ' + ok + (ok ? '' : ' :: ' + JSON.stringify(validate.errors).slice(0, 200))); }
  if (ok !== expectValid) console.log('   errors: ' + JSON.stringify(validate.errors).slice(0, 300));
}
console.log('\nSchema-example check: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
