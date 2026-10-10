// Minimal CDP-over-pipe driver for Chrome (no dependencies).
// Launches Chrome with --remote-debugging-pipe so we can call Extensions.loadUnpacked.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export async function launch({ headless = true, extraArgs = [] } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvc-chrome-'));
  const args = [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const writer = proc.stdio[3];
  const reader = proc.stdio[4];
  let buf = Buffer.alloc(0);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  reader.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx;
    while ((idx = buf.indexOf(0)) !== -1) {
      const msg = JSON.parse(buf.subarray(0, idx).toString('utf8'));
      buf = buf.subarray(idx + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else {
        for (const l of listeners) l(msg);
      }
    }
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d.toString()));
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const msg = { id: ++id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      pending.set(msg.id, { resolve, reject });
      writer.write(JSON.stringify(msg) + '\0');
    });
  const on = (fn) => listeners.push(fn);
  const close = async () => {
    try { await send('Browser.close'); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} ; try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} }, 1500);
  };
  return { send, on, close, proc, stderr: () => stderr, userDataDir };
}

export async function openPage(b, url) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  await s('Runtime.enable');
  await s('Page.enable');
  const logs = [];
  b.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') logs.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (msg.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  });
  if (url) await s('Page.navigate', { url });
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { targetId, sessionId, s, evaluate, logs };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
