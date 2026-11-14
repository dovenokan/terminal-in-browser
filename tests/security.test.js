'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const WebSocket = require('../server/node_modules/ws');

const { createBridge, getShellSpec, validateCwd, MAX_PAYLOAD_BYTES, MAX_INPUT_BYTES } = require('../server/server');
const {
  MAX_MSG_BYTES,
  FIREFOX_ID,
  isAuthorizedCaller,
  allowOriginForCaller,
  createMessageProcessor,
} = require('../host/host');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pstab-sec-test-'));
}

function createMockPtyFactory() {
  const spawned = [];
  const spawnPty = (file, args, opts) => {
    const dataListeners = [];
    const exitListeners = [];
    const pty = {
      file,
      args,
      opts,
      writes: [],
      resizes: [],
      paused: false,
      killed: false,
      write(d) { this.writes.push(d); },
      resize(c, r) { this.resizes.push([c, r]); },
      pause() { this.paused = true; },
      resume() { this.paused = false; },
      kill() { this.killed = true; },
      onData(fn) { dataListeners.push(fn); },
      onExit(fn) { exitListeners.push(fn); },
      emitData(d) { for (const fn of dataListeners) fn(d); },
      emitExit(code) { for (const fn of exitListeners) fn({ exitCode: code }); },
    };
    spawned.push(pty);
    return pty;
  };
  return { spawnPty, spawned };
}

function connectWs(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
    });
  });
}

function waitClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: 1006, reason: '' });
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (data, isBinary) => resolve({ data, isBinary }));
    ws.once('close', (code) => reject(new Error(`closed:${code}`)));
  });
}

const VALID_CHROME_ID = 'dngngknlkbcklaaladkapmomknmehfin';
const VALID_CHROME_ORIGIN = `chrome-extension://${VALID_CHROME_ID}`;
const ALT_MOZ_ORIGIN = 'moz-extension://11111111-2222-3333-4444-555555555555';

async function setupBridge(extraOpts = {}) {
  const dir = makeTempDir();
  const extIdFile = path.join(dir, 'extension-id.txt');
  const tokenFile = path.join(dir, '.token');
  const originsFile = path.join(dir, 'allowed-origins.txt');
  fs.writeFileSync(extIdFile, VALID_CHROME_ID);
  fs.writeFileSync(originsFile, `${ALT_MOZ_ORIGIN}\n`);
  const mock = createMockPtyFactory();

  const bridge = createBridge({
    port: 0,
    root: dir,
    extIdFile,
    tokenFile,
    originsFile,
    spawnPty: mock.spawnPty,
    graceMs: 500,
    authMs: 500,
    ...extraOpts,
  });

  await new Promise((resolve) => bridge.wss.once('listening', resolve));
  const { port, address } = bridge.wss.address();
  return {
    dir,
    bridge,
    mock,
    port,
    address,
    url: `ws://${address}:${port}/`,
    cleanup: async () => {
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('WebSocket binds exclusively to 127.0.0.1', async () => {
  const ctx = await setupBridge();
  try {
    assert.equal(ctx.address, '127.0.0.1');
  } finally {
    await ctx.cleanup();
  }
});

test('Rejects missing, malformed, and unauthorized Origin and Host headers', async () => {
  const ctx = await setupBridge();
  try {
    // Missing Origin
    await assert.rejects(() => connectWs(ctx.url, { Host: `127.0.0.1:${ctx.port}` }), /HTTP 401/);
    // Web origin
    await assert.rejects(() => connectWs(ctx.url, { Origin: 'https://evil.example', Host: `127.0.0.1:${ctx.port}` }), /HTTP 401/);
    // Unknown extension origin
    await assert.rejects(() => connectWs(ctx.url, { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Host: `127.0.0.1:${ctx.port}` }), /HTTP 401/);
    // Malformed origin
    await assert.rejects(() => connectWs(ctx.url, { Origin: 'not-a-url', Host: `127.0.0.1:${ctx.port}` }), /HTTP 401/);
    // DNS rebinding Host header
    await assert.rejects(() => connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN, Host: `evil.com:${ctx.port}` }), /HTTP 401/);
    assert.equal(ctx.mock.spawned.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('Rejects invalid authentication tokens and prevents shell execution', async () => {
  const ctx = await setupBridge();
  try {
    const ws = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const closed = waitClose(ws);
    ws.send(Buffer.from(JSON.stringify({ t: 'hello', token: 'wrong-token' })), { binary: true });
    // Attempt to send shell command immediately after bad auth
    ws.send('echo PWNED\r\n');
    const res = await closed;
    assert.equal(res.code, 4401);
    assert.equal(ctx.mock.spawned.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('Enforces auth timeout for silent unauthenticated connections', async () => {
  const ctx = await setupBridge({ authMs: 120 });
  try {
    const ws = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const res = await waitClose(ws);
    assert.equal(res.code, 4408);
    assert.equal(ctx.mock.spawned.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('Rate-limits repeated authentication failures', async () => {
  const ctx = await setupBridge({ authLockoutMs: 5000 });
  try {
    for (let i = 0; i < 5; i++) {
      const ws = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
      const closed = waitClose(ws);
      ws.send(Buffer.from(JSON.stringify({ t: 'hello', token: 'bad' })), { binary: true });
      const res = await closed;
      assert.equal(res.code, 4401);
    }
    // 6th attempt even with valid token is blocked during lockout
    const wsBlocked = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const closedBlocked = waitClose(wsBlocked);
    wsBlocked.send(Buffer.from(JSON.stringify({ t: 'hello', token: ctx.bridge.getToken() })), { binary: true });
    const resBlocked = await closedBlocked;
    assert.equal(resBlocked.code, 4429);
    assert.equal(ctx.mock.spawned.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('Token rotation and expiration invalidate old tokens', async () => {
  const ctx = await setupBridge({ tokenTtlMs: 80 });
  try {
    const oldToken = ctx.bridge.getToken();
    assert.match(oldToken, /^[0-9a-f]{64}$/);

    // Wait for TTL expiry
    await new Promise((r) => setTimeout(r, 120));

    const ws = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const closed = waitClose(ws);
    ws.send(Buffer.from(JSON.stringify({ t: 'hello', token: oldToken })), { binary: true });
    const res = await closed;
    assert.equal(res.code, 4401);

    const rotatedToken = ctx.bridge.getToken();
    assert.notEqual(rotatedToken, oldToken);

    // New token succeeds
    const ws2 = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const msgPromise = nextMessage(ws2);
    ws2.send(Buffer.from(JSON.stringify({ t: 'hello', token: rotatedToken })), { binary: true });
    const { data, isBinary } = await msgPromise;
    assert.equal(isBinary, true);
    const ready = JSON.parse(data.toString());
    assert.equal(ready.t, 'ready');
    ws2.close();
  } finally {
    await ctx.cleanup();
  }
});

test('Rejects malformed WebSocket control payloads without crashing server', async () => {
  const ctx = await setupBridge();
  try {
    const ws = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const msgPromise = nextMessage(ws);
    ws.send(Buffer.from(JSON.stringify({ t: 'hello', token: ctx.bridge.getToken() })), { binary: true });
    await msgPromise;

    // Send binary "null" (previously crashed server with TypeError)
    const closed1 = waitClose(ws);
    ws.send(Buffer.from('null'), { binary: true });
    const r1 = await closed1;
    assert.equal(r1.code, 1008);

    // Connect again and send negative ack
    const ws2 = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const msg2 = nextMessage(ws2);
    ws2.send(Buffer.from(JSON.stringify({ t: 'hello', token: ctx.bridge.getToken() })), { binary: true });
    await msg2;
    const closed2 = waitClose(ws2);
    ws2.send(Buffer.from(JSON.stringify({ t: 'ack', n: -500 })), { binary: true });
    const r2 = await closed2;
    assert.equal(r2.code, 1008);
  } finally {
    await ctx.cleanup();
  }
});

test('Rejects oversized WebSocket messages and oversized input frames', async () => {
  const ctx = await setupBridge();
  try {
    const ws = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const msgPromise = nextMessage(ws);
    ws.send(Buffer.from(JSON.stringify({ t: 'hello', token: ctx.bridge.getToken() })), { binary: true });
    await msgPromise;

    // Exceeds MAX_INPUT_BYTES (64 KB)
    const closed = waitClose(ws);
    ws.send('A'.repeat(MAX_INPUT_BYTES + 1));
    const res = await closed;
    assert.equal(res.code, 1009);
    assert.equal(ctx.mock.spawned[0].writes.length, 0);

    // Exceeds MAX_PAYLOAD_BYTES (512 KB) at ws layer
    const ws2 = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    ws2.on('error', () => {});
    const msg2 = nextMessage(ws2);
    ws2.send(Buffer.from(JSON.stringify({ t: 'hello', token: ctx.bridge.getToken() })), { binary: true });
    await msg2;
    const closed2 = waitClose(ws2);
    ws2.send('B'.repeat(MAX_PAYLOAD_BYTES + 1024));
    const res2 = await closed2;
    assert.ok(res2.code === 1009 || res2.code === 1006, `expected 1009 or 1006, got ${res2.code}`);
  } finally {
    await ctx.cleanup();
  }
});

test('Enforces session isolation across origins and handles disconnect/reconnect + process cleanup', async () => {
  const ctx = await setupBridge({ graceMs: 100 });
  try {
    // 1. Chrome opens a session
    const ws1 = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const readyPromise = nextMessage(ws1);
    ws1.send(Buffer.from(JSON.stringify({ t: 'hello', token: ctx.bridge.getToken() })), { binary: true });
    const ready = JSON.parse((await readyPromise).data.toString());
    assert.equal(ready.t, 'ready');
    const sessionId = ready.session;

    // 2. Firefox origin attempts to hijack Chrome's session
    const wsOther = await connectWs(ctx.url, { Origin: ALT_MOZ_ORIGIN });
    const closedOther = waitClose(wsOther);
    wsOther.send(Buffer.from(JSON.stringify({ t: 'hello', token: ctx.bridge.getToken(), session: sessionId })), { binary: true });
    const resOther = await closedOther;
    assert.equal(resOther.code, 4403);

    // 3. Unexpected disconnect & reconnect by same origin within graceMs
    ws1.terminate();
    await new Promise((r) => setTimeout(r, 20));
    const wsRe = await connectWs(ctx.url, { Origin: VALID_CHROME_ORIGIN });
    const rePromise = nextMessage(wsRe);
    wsRe.send(Buffer.from(JSON.stringify({ t: 'hello', token: ctx.bridge.getToken(), session: sessionId })), { binary: true });
    const reReady = JSON.parse((await rePromise).data.toString());
    assert.equal(reReady.resumed, true);
    assert.equal(reReady.session, sessionId);
    assert.equal(ctx.mock.spawned[0].killed, false);

    // 4. Disconnect and let graceMs expire -> PTY killed
    wsRe.close();
    await new Promise((r) => setTimeout(r, 180));
    assert.equal(ctx.mock.spawned[0].killed, true);
    assert.equal(ctx.bridge.sessions.size, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('Shell executable resolution uses absolute paths and validateCwd rejects null bytes and UNC paths', () => {
  const [psExe] = getShellSpec('powershell');
  const [cmdExe] = getShellSpec('cmd');
  assert.equal(path.isAbsolute(psExe), true);
  assert.equal(path.isAbsolute(cmdExe), true);

  const fallback = process.env.USERPROFILE || process.cwd();
  assert.equal(validateCwd('C:\\Windows\0evil'), fallback);
  assert.equal(validateCwd('\\\\attacker\\share'), fallback);
  assert.equal(validateCwd('//attacker/share'), fallback);
  assert.equal(validateCwd(12345), fallback);
});

test('End-to-end real node-pty session executes safe command and exits cleanly', async () => {
  const dir = makeTempDir();
  const extIdFile = path.join(dir, 'extension-id.txt');
  const tokenFile = path.join(dir, '.token');
  const originsFile = path.join(dir, 'allowed-origins.txt');
  fs.writeFileSync(extIdFile, VALID_CHROME_ID);
  fs.writeFileSync(originsFile, '');

  const bridge = createBridge({
    port: 0,
    root: dir,
    extIdFile,
    tokenFile,
    originsFile,
    graceMs: 200,
    authMs: 2000,
  });

  try {
    await new Promise((resolve) => bridge.wss.once('listening', resolve));
    const { port, address } = bridge.wss.address();
    const ws = await connectWs(`ws://${address}:${port}/`, { Origin: VALID_CHROME_ORIGIN });

    let output = '';
    let gotReady = false;
    let exitCode = null;
    const done = new Promise((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          output += data.toString();
          return;
        }
        const m = JSON.parse(data.toString());
        if (m.t === 'ready') {
          gotReady = true;
          ws.send('echo PSTAB_E2E_OK\r\nexit 0\r\n');
        } else if (m.t === 'exit') {
          exitCode = m.code;
          resolve();
        }
      });
    });

    ws.send(Buffer.from(JSON.stringify({ t: 'hello', token: bridge.getToken(), shell: 'cmd' })), { binary: true });
    await done;
    assert.equal(gotReady, true);
    assert.equal(exitCode, 0);
    assert.match(output, /PSTAB_E2E_OK/);
    ws.close();
  } finally {
    await bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Native Messaging host rejects unauthorized callers and enforces size/JSON limits', async () => {
  const dir = makeTempDir();
  const extIdFile = path.join(dir, 'extension-id.txt');
  const serverDir = path.join(dir, 'server');
  fs.mkdirSync(serverDir);
  fs.writeFileSync(extIdFile, VALID_CHROME_ID);

  try {
    // Caller validation
    assert.equal(isAuthorizedCaller([], extIdFile), false);
    assert.equal(isAuthorizedCaller(['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], extIdFile), false);
    assert.equal(isAuthorizedCaller([`${VALID_CHROME_ORIGIN}/`], extIdFile), true);
    assert.equal(isAuthorizedCaller(['manifest.json', FIREFOX_ID], extIdFile), true);

    // Origin allow-list enforcement
    assert.equal(allowOriginForCaller('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [`${VALID_CHROME_ORIGIN}/`], { extIdFile, serverDir }), false);
    assert.equal(allowOriginForCaller(VALID_CHROME_ORIGIN, [`${VALID_CHROME_ORIGIN}/`], { extIdFile, serverDir }), true);

    // Oversized / zero-length / malformed native messaging frames
    const replies = [];
    let fatalCount = 0;
    const proc = createMessageProcessor({
      caller: [`${VALID_CHROME_ORIGIN}/`],
      extIdFile,
      serverDir,
      startFn: async () => ({ ok: true, token: 'test' }),
      shellsFn: () => ({ powershell: true }),
      sendFn: (o) => replies.push(o),
      onFatal: () => { fatalCount++; },
    });

    // Zero-length frame
    const zeroHdr = Buffer.alloc(4);
    zeroHdr.writeUInt32LE(0, 0);
    await proc.pushChunk(zeroHdr);
    assert.equal(fatalCount, 1);
    assert.equal(replies.at(-1).error, 'invalid message size');

    // Oversized frame
    const bigHdr = Buffer.alloc(4);
    bigHdr.writeUInt32LE(MAX_MSG_BYTES + 1, 0);
    await proc.pushChunk(bigHdr);
    assert.equal(fatalCount, 2);
    assert.equal(replies.at(-1).error, 'invalid message size');

    // Malformed JSON frame
    const badBody = Buffer.from('{bad json');
    const badHdr = Buffer.alloc(4);
    badHdr.writeUInt32LE(badBody.length, 0);
    await proc.pushChunk(Buffer.concat([badHdr, badBody]));
    assert.equal(replies.at(-1).error, 'malformed json');

    // Unknown command
    const unkBody = Buffer.from(JSON.stringify({ cmd: 'exec', run: 'whoami' }));
    const unkHdr = Buffer.alloc(4);
    unkHdr.writeUInt32LE(unkBody.length, 0);
    await proc.pushChunk(Buffer.concat([unkHdr, unkBody]));
    assert.equal(replies.at(-1).error, 'unknown command');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
