// One-shot Nevermined CLI auth callback server (key capture, no logging).
// ----------------------------------------------------------------------
// SECURITY REQUIREMENT (operator): the API key arrives in the query string
// (?nvm_api_key=sandbox:...) — the most-logged part of an HTTP request.
// THIS SERVER NEVER LOGS, PRINTS, OR WRITES THE REQUEST LINE OR QUERY
// STRING. It parses the query in memory, stores the key into .env, writes a
// timestamp-only flag file (no key), and exits immediately.
//
// Usage:  node scripts/nvm-callback-server.js      (cwd = saax-protocol)
// Env:
//   NVM_ENV_FILE   optional override for the .env path (default ../.env)
//
// Output (stdout only, never the request line / query / key):
//   LISTENING 127.0.0.1:<port>   -> on bind (this is what the launcher parses)
//   CALLBACK_OK                  -> key captured, .env updated, server exited
//   CALLBACK_NO_KEY              -> callback hit but no nvm_api_key param
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ENV_FILE = process.env.NVM_ENV_FILE ? path.resolve(process.env.NVM_ENV_FILE)
  : path.join(__dirname, '..', '.env');
const FLAG_FILE = path.join(__dirname, '..', '.nvm-key-captured.flag');

// Write NVM_API_KEY into the existing secret block of .env (atomic tmp+rename).
function storeKey(key) {
  let env = '';
  if (fs.existsSync(ENV_FILE)) env = fs.readFileSync(ENV_FILE, 'utf8');
  const line = 'NVM_API_KEY=' + key;
  if (/^NVM_API_KEY=.*$/m.test(env)) {
    env = env.replace(/^NVM_API_KEY=.*$/m, line);
  } else {
    // Insert directly under the existing secret block (PostgREST secrets).
    const anchored = env.replace(
      /(# Store client: Docker PostgREST[\s\S]*?SAAX_POSTGREST_KEY=\S+)\n?/,
      '$1\n\n# Nevermined sandbox API key (captured via CLI sign-in; DO NOT COMMIT)\n' + line + '\n'
    );
    env = anchored.indexOf('NVM_API_KEY=') === -1
      ? env + '\n# Nevermined sandbox API key (captured via CLI sign-in; DO NOT COMMIT)\n' + line + '\n'
      : anchored;
  }
  const tmp = ENV_FILE + '.tmp';
  fs.writeFileSync(tmp, env, 'utf8');
  fs.renameSync(tmp, ENV_FILE);
  // Flag file carries ONLY a timestamp — never the key.
  fs.writeFileSync(FLAG_FILE, new Date().toISOString(), 'utf8');
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/callback' || u.pathname === '/callback/') {
      const key = u.searchParams.get('nvm_api_key');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      if (key) {
        storeKey(key);
        res.end('OK - key captured. This window can be closed.');
        console.log('CALLBACK_OK');
        setImmediate(() => { try { server.close(); } catch (_) {} process.exit(0); });
      } else {
        res.end('No nvm_api_key in query.');
        console.log('CALLBACK_NO_KEY');
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  } catch (_) {
    try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('error'); } catch (__) {}
    console.log('CALLBACK_ERR');
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log('LISTENING 127.0.0.1:' + server.address().port);
});