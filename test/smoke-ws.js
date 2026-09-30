'use strict';
/** WebSocket protocol smoke test against a fake brain (no browser). */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

process.env.KONEQTI_QUIET = '1';
const { BrainClient } = require('../websocket-client');
const { JsonStore } = require('../store');
const { ProfileManager } = require('../profile-manager');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koneqti-ws-'));
  const pm = new ProfileManager({ store: new JsonStore({ dir, name: 'ws', defaults: { profiles: [] } }) });
  pm.add({ platform: 'linkedin', handle: 'me' });
  const received = [];
  let headerSecret = null;
  const wss = new WebSocketServer({ port: 0, path: '/ws' });
  wss.on('connection', (sock, req) => {
    headerSecret = req.headers['x-electron-secret'];
    sock.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      received.push(m);
      if (m.type === 'hello') {
        sock.send(JSON.stringify({ type: 'welcome', payload: { user_id: 'u1', server_time: new Date().toISOString(), limits: { linkedin: 12 }, paused_platforms: ['facebook'] } }));
        sock.send(JSON.stringify({ type: 'job', payload: { job_id: 'j1', job_type: 'scrape_website', engine: 'chromium_patched', payload: { url: 'x' } } }));
      }
      if (m.type === 'ai_selector_request') {
        sock.send(JSON.stringify({ type: 'ai_selector_response', payload: { job_id: m.payload.job_id, step_id: m.payload.step_id, selector: '#ok' } }));
      }
    });
  });
  await new Promise((r) => wss.on('listening', r));
  const port = wss.address().port;

  const enqueued = [];
  const runner = {
    pausedAll: false,
    enqueue: (j) => enqueued.push(j),
    cancel: () => {},
    runningJobIds: () => ['j1'],
    setPausedPlatforms: (p) => { runner.paused = p; },
    pausePlatform: () => {},
    resumePlatform: () => {},
  };
  const client = new BrainClient({
    url: `ws://127.0.0.1:${port}/ws`,
    secret: 's3cret',
    auth: { getAccessToken: async () => 'tok', getSession: async () => ({ expires_at: Date.now() / 1000 + 3600 }), refresh: async () => null },
    deviceId: 'dev1',
    appVersion: '0.1.0',
    runner,
    profileManager: pm,
    engines: () => ['chromium_patched'],
  });
  // Buffered before connect:
  client.send('job_result', { job_id: 'old', status: 'success', data: {} });
  client.start();
  await new Promise((r) => setTimeout(r, 800));

  const sel = await client.requestSelector({ job_id: 'j1', step_id: 's1', goal: 'click send', accessibility_tree: 'tree' });
  await new Promise((r) => setTimeout(r, 200));

  const types = received.map((m) => m.type);
  assert.strictEqual(headerSecret, 's3cret');
  assert.strictEqual(types[0], 'hello');
  const hello = received[0].payload;
  assert.strictEqual(hello.access_token, 'tok');
  assert.strictEqual(hello.device_id, 'dev1');
  assert.deepStrictEqual(hello.engines, ['chromium_patched']);
  assert.strictEqual(hello.profiles.length, 1);
  assert.ok(types.includes('heartbeat'));
  const hb = received.find((m) => m.type === 'heartbeat').payload;
  assert.deepStrictEqual(hb.running_jobs, ['j1']);
  assert.ok(typeof hb.cpu === 'number' && typeof hb.free_mem_mb === 'number');
  assert.ok(types.includes('job_ack'));
  assert.ok(received.some((m) => m.type === 'job_result' && m.payload.job_id === 'old'), 'outbox flushed');
  assert.strictEqual(enqueued[0].job_id, 'j1');
  assert.deepStrictEqual(runner.paused, ['facebook']);
  assert.strictEqual(pm.brainLimits.linkedin, 12);
  assert.strictEqual(sel, '#ok');
  assert.strictEqual(client.isConnected(), true);
  client.stop();
  wss.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok   websocket protocol: hello/welcome/job/job_ack/heartbeat/outbox/ai_selector round-trip');
})().catch((err) => { console.error('WS SMOKE FAILED:', err); process.exitCode = 1; });
