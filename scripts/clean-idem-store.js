// clean-idem-store.js — purge stale idempotency rows from the PostgREST store
// (test debris from debug runs). Uses the project's own store client so the
// request goes through the same schema-scoped PostgREST path as production.
require('dotenv').config({ path: require('path').join(process.cwd(), '.env') });
const store = require('../endpoint/store.js');

(async () => {
  const client = store.buildStoreClient();
  if (!client) { console.log('NO_STORE'); process.exit(0); }
  // select all keys (paged)
  let all = [];
  for (let i = 0; i < 20; i++) {
    const { data, error } = await client.from('idempotency_keys').select('key').limit(1000);
    if (error) { console.log('SELECT_ERR', error.message); break; }
    if (!data || !data.length) break;
    all = all.concat(data.map(r => r.key));
  }
  console.log('TOTAL_KEYS=' + all.length);
  if (all.length) {
    const { error } = await client.from('idempotency_keys').delete().in('key', all);
    console.log(error ? 'DELETE_ERR ' + error.message : 'DELETE_OK ' + all.length);
  }
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });