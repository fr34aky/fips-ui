#!/usr/bin/env node
// Smoke test of a fresh fips install from the Upgrade page (used by .github/workflows/smoke.yml): on a machine where
// fips-ui runs but fips is not installed, start the install job through the API and follow it to the end.
//   node scripts/smoke-install-daemon.mjs [--url http://127.0.0.1:8321] [--peer npub1...@udp/host:port]...
// The job may end with fips-ui restarting itself (to join the fips group): the server going away then is expected.
// Exits non-zero if the job fails; afterwards run scripts/smoke-test.mjs --daemon.
const args = process.argv.slice(2);
const base = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://127.0.0.1:8321';
const peers = args.flatMap((a, i) => (a === '--peer' ? [args[i + 1]] : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, body) {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${path}: HTTP ${r.status} ${j.error ?? ''}`), { status: r.status });
  return j;
}

const st = await call('/api/upgrade/status');
if (st.installed?.path || st.running) { console.log(`FAIL fips is already installed (${st.installed?.path ?? 'running'})`); process.exit(1); }
console.log(`ok   fips not installed; helper ${st.helper?.available ? `v${st.helper.version}` : 'missing'}`);
const job = await call('/api/upgrade/install-daemon', { peers });
console.log(`ok   install job ${job.id} started (peers: ${peers.length})`);

let seq = 0, last = null, gone = 0;
for (let i = 0; i < 300; i++) {
  try {
    const j = await call(`/api/upgrade/jobs/current?since=${seq}`);
    gone = 0;
    if (j.id !== job.id) { console.log('ok   fips-ui restarted after the job (new process, no current job)'); break; }
    for (const l of j.log) { console.log(`     ${l.line}`); seq = l.seq; }
    last = j;
    if (j.state === 'failed' || j.state === 'cancelled') { console.log(`FAIL job ${j.state}: ${j.error}`); process.exit(1); }
    if (j.state === 'succeeded' && !j.result?.restarted) break;
  } catch (e) {
    // A 404 after the restart: the new process answers and has no job (the old one ended with it).
    if (e.status === 404 && last?.state === 'succeeded' && last.result?.restarted) { console.log('ok   fips-ui restarted after the job (new process, no current job)'); break; }
    // Expected while fips-ui restarts into the fips group; anything longer is a failure.
    if (last?.state === 'succeeded' && last.result?.restarted) { if (++gone > 60) { console.log('FAIL fips-ui did not come back after its restart'); process.exit(1); } }
    else if (++gone > 10) { console.log(`FAIL ${e.message}`); process.exit(1); }
  }
  await sleep(1000);
}
if (!last || last.state !== 'succeeded') { console.log('FAIL the job did not finish in time'); process.exit(1); }
console.log(`ok   fips installed (${last.result?.artifact ?? '?'})${last.result?.restarted ? '; fips-ui restarted into the fips group' : ''}`);
