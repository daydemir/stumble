/**
 * Zero-dependency test runner: serves the repo on loopback, drives headless
 * Chrome over the DevTools protocol with Node built-ins, and runs
 * test/suite.js three times in one page: with motion allowed, with
 * prefers-reduced-motion: reduce emulated, and with it cleared again, so the
 * live media-query handling is exercised in both directions.
 *
 *   npm test
 *   CHROME_PATH=/path/to/chrome npm test
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const DEFAULT_CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
}[process.platform];
const CHROME = process.env.CHROME_PATH ?? DEFAULT_CHROME;
if (!CHROME || !existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);

const server = createServer(async (req, res) => {
  const file = resolve(ROOT, `.${decodeURIComponent(new URL(req.url, 'http://x').pathname)}`);
  if (!file.startsWith(ROOT + sep) || !MIME[extname(file)]) return res.writeHead(404).end();
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const pageUrl = `http://127.0.0.1:${server.address().port}/test/index.html`;

const profile = await mkdtemp(join(tmpdir(), 'stumble-test-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
);
const portFile = join(profile, 'DevToolsActivePort');
for (let i = 0; !existsSync(portFile); i++) {
  if (i > 100) throw new Error('Chrome did not start');
  await sleep(100);
}
const debugPort = (await readFile(portFile, 'utf8')).split('\n')[0];
const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();

// Just enough of the DevTools protocol: commands, plus one-shot event waits.
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((open) => socket.addEventListener('open', open));
const waiting = new Map();
let nextId = 0;
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  const key = message.id ?? message.method;
  waiting.get(key)?.(message);
  waiting.delete(key);
});
const awaitMessage = (key) => new Promise((done) => waiting.set(key, done));
const send = (method, params = {}) => {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return awaitMessage(id).then((message) => {
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  });
};
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};

await send('Page.enable');
const loaded = awaitMessage('Page.loadEventFired');
await send('Page.navigate', { url: pageUrl });
await loaded;

const passes = [
  ['motion', []],
  ['reduced-motion', [{ name: 'prefers-reduced-motion', value: 'reduce' }]],
  ['motion again', []],
];
let total = 0;
let failed = 0;
for (const [name, features] of passes) {
  await send('Emulation.setEmulatedMedia', { features });
  for (const result of await evaluate(`import('/test/suite.js').then((suite) => suite.run())`)) {
    total += 1;
    if (result.pass) {
      console.log(`  ok   [${name}] ${result.name}`);
    } else {
      failed += 1;
      console.log(`  FAIL [${name}] ${result.name}\n         ${JSON.stringify(result.detail)}`);
    }
  }
}

socket.close();
server.close();
const exited = new Promise((done) => chrome.once('exit', done));
chrome.kill();
await exited; // Chrome writes its profile on shutdown; remove it only after.
await rm(profile, { recursive: true, force: true });

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
