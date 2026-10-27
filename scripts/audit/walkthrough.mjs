#!/usr/bin/env node
/**
 * Walkthrough harness for Gameday Command: a scripted tour of the real app in
 * headless Chromium that doubles as an end-to-end smoke test.
 *
 *   source /projects/sandbox/.kiro/env.sh
 *   node scripts/audit/walkthrough.mjs --list
 *   node scripts/audit/walkthrough.mjs start views tabs
 *   node scripts/audit/walkthrough.mjs all --strict
 *   node scripts/audit/walkthrough.mjs missing --max-minutes=20
 *
 * Built around one sandbox rule: background processes die when the shell call
 * ends. So this one process spawns the API server and Vite, waits for both
 * ports, drives the browser through the named flows, writes artifacts, and
 * always stops both children (on success, on error and on a signal). Each
 * child also carries a watchdog that kills its own process group if this
 * process disappears (even by SIGKILL), and --max-minutes makes the whole run
 * stop cleanly before an outer timeout can cut it off mid-flow.
 *
 * No npm dependencies. playwright-core and Chromium come from the environment
 * (GD_PLAYWRIGHT_CORE, GD_CHROMIUM). The server's database and any imported
 * stadium go to an isolated folder under the artifacts directory unless
 * --repo-data is passed, so a run never writes into the repo's data/.
 * See scripts/audit/README.md.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Paths and fixed settings ─────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SANDBOX = resolve(REPO, '..');
const OUT = resolve(process.env.GD_AUDIT_OUT ?? join(SANDBOX, '.kiro', 'artifacts', 'audit'));
const SHOTS = resolve(process.env.GD_AUDIT_SHOTS ?? join(SANDBOX, '.kiro', 'artifacts', 'screenshots'));
const SERVER_DIR = join(OUT, '_server');
/** Fixed by app/vite.config.ts, which proxies /api to http://127.0.0.1:8787. */
const API_PORT = 8787;
const WEB_PORT = 5173;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const OHIO = '/?map=ohio-stadium';
const CHROME_ARGS = ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const SPEEDS = [5, 20, 60];

const HELP = `Usage: node scripts/audit/walkthrough.mjs <flow|group ...> [options]

Each flow runs in a fresh browser context against one API server + Vite pair
that this script starts and always stops. Artifacts go to
  ${OUT}/<flow>/   (page text, aria snapshots, console, summary.json)
  ${SHOTS}/audit-<flow>-<step>.jpg

Options
  --list             list flows and groups, then exit
  --speed=5|20|60    simulation speed button to press (default 60)
  --timebox=SECONDS  wall-clock cap for each incident run (default 180; package 360)
  --no-shots         no screenshots (text, aria and summaries are still written)
  --shot-cap=N       cap on audit-*.jpg files in the screenshots folder (default 45)
  --repo-data        use the repo's data/gameday.db and data/stadiums (default: isolated copy)
  --base-url=URL     drive an app that is already running; spawn nothing
  --headed           show the browser (needs a display)
  --strict           exit 1 when any check fails, not only when a step errors
  --max-minutes=N    wall-clock budget for the whole invocation (default 25):
                     flows that no longer fit are skipped, and the run stops
                     cleanly, children included, before the budget runs out

Groups: all, quick, interact, incidents, plus two read from index.json:
  missing  flows that have no entry yet (never ran, or the run was cut off)
  failed   flows whose last status was "error" or that never finished

Environment: GD_CHROMIUM and GD_PLAYWRIGHT_CORE (source .kiro/env.sh),
optional GD_AUDIT_OUT and GD_AUDIT_SHOTS to move the artifacts.`;

// ── Command line ─────────────────────────────────────────────────────
const opts = { list: false, help: false, shots: true, shotCap: 45, timebox: null, speed: 60, repoData: false, headed: false, baseUrl: null, strict: false, maxMinutes: 25 };
const requested = [];
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, ''];
  if (key === '--list') opts.list = true;
  else if (key === '--help' || key === '-h') opts.help = true;
  else if (key === '--no-shots') opts.shots = false;
  else if (key === '--shot-cap') opts.shotCap = Number(value);
  else if (key === '--timebox') opts.timebox = Number(value);
  else if (key === '--speed') opts.speed = Number(value);
  else if (key === '--repo-data') opts.repoData = true;
  else if (key === '--headed') opts.headed = true;
  else if (key === '--base-url') opts.baseUrl = value.replace(/\/$/, '');
  else if (key === '--strict') opts.strict = true;
  else if (key === '--max-minutes') opts.maxMinutes = Number(value);
  else if (key.startsWith('--')) fail(`unknown option ${arg}\n\n${HELP}`);
  else requested.push(arg);
}
if (!SPEEDS.includes(opts.speed)) fail(`--speed must be one of ${SPEEDS.join(', ')} (the app's speed buttons)`);
if (!(opts.maxMinutes > 0)) fail('--max-minutes must be a positive number');
if (!(opts.shotCap >= 0)) fail('--shot-cap must be 0 or more');
if (opts.timebox !== null && !(opts.timebox > 0)) fail('--timebox must be a positive number of seconds');
/** When this invocation must be done, children stopped, artifacts written. */
const RUN_DEADLINE = Date.now() + opts.maxMinutes * 60000;
const BASE = opts.baseUrl ?? `http://127.0.0.1:${WEB_PORT}`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

// ── Small utilities ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const log = (...a) => console.log('[walkthrough]', ...a);

/** Poll until fn returns something truthy, or give up after timeout ms (returns null). */
async function poll(fn, { timeout = 10000, interval = 500 } = {}) {
  const end = Date.now() + Math.max(0, timeout);
  do {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // keep polling: the page may be mid-render or mid-navigation
    }
    await sleep(interval);
  } while (Date.now() < end);
  return null;
}

/** Reject a promise that takes too long, so one stuck call cannot hang the run. */
function within(ms, promise, what) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

// ── Child processes: spawn, wait, always stop ────────────────────────
const children = [];
let browser = null;
let exiting = false;

/**
 * Preloaded into every child (node --import). Exit handlers in this process
 * cannot run on SIGKILL or when an outer timeout tears it down, and a detached
 * child would then outlive it holding ports 8787/5173. So each child polls for
 * its parent once a second and, when the parent is gone, kills its own process
 * group (it leads one: see `detached` below), Vite's esbuild service included.
 */
const WATCHDOG = `data:text/javascript,${encodeURIComponent(`
const parent = Number(process.env.GD_AUDIT_PARENT);
if (parent > 1) {
  setInterval(() => {
    let gone = process.ppid !== parent;
    if (!gone) { try { process.kill(parent, 0); } catch { gone = true; } }
    if (!gone) return;
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    process.exit(1);
  }, 1000).unref();
}`)}`;

function spawnNode(name, script, args, cwd, env) {
  mkdirSync(SERVER_DIR, { recursive: true });
  const logPath = join(SERVER_DIR, `${name}.log`);
  const out = createWriteStream(logPath);
  // detached: the child leads its own process group, so the whole group
  // (Vite's esbuild service included) can be signalled at once.
  const child = spawn(process.execPath, ['--import', WATCHDOG, script, ...args], {
    cwd,
    env: { ...process.env, ...env, GD_AUDIT_PARENT: String(process.pid) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.label = name;
  child.logPath = logPath;
  children.push(child);
  return child;
}

const alive = (c) => c.exitCode === null && c.signalCode === null;

function signalChildren(signal) {
  for (const c of children) {
    if (!alive(c)) continue;
    try {
      process.kill(-c.pid, signal);
    } catch {
      try {
        c.kill(signal);
      } catch {
        // already gone
      }
    }
  }
}

async function stopChildren() {
  if (!children.length) return;
  signalChildren('SIGTERM');
  const until = Date.now() + 5000;
  while (children.some(alive) && Date.now() < until) await sleep(100);
  signalChildren('SIGKILL');
  // Say so if anything still answers on our ports: that would block the next run.
  if (!opts.baseUrl) {
    await sleep(300);
    const open = [];
    for (const port of [API_PORT, WEB_PORT]) if (await portOpen(port)) open.push(port);
    if (open.length) console.error(`[walkthrough] WARNING: port(s) ${open.join(', ')} still open after stopping the children`);
    else log(`children stopped; ports ${API_PORT} and ${WEB_PORT} are free`);
  }
}

async function shutdown(code, why) {
  if (exiting) return;
  exiting = true;
  if (why) console.error(`[walkthrough] stopping: ${why}`);
  // Never let a hung browser or a slow child keep this process (and so the
  // children's watchdogs) alive: whatever happens, exit within ~20 s.
  setTimeout(() => {
    signalChildren('SIGKILL');
    process.exit(code || 2);
  }, 20000).unref();
  try {
    if (browser) await Promise.race([browser.close(), sleep(5000)]);
  } catch {
    // the browser may already be gone
  }
  await stopChildren();
  process.exit(code);
}

// Last line of defence: whatever happens, the children go with us.
process.on('exit', () => signalChildren('SIGKILL'));
// Backstop for --max-minutes: the main loop already caps every flow to the time
// left, so this only fires if something hangs past the budget.
setTimeout(() => void shutdown(3, `--max-minutes=${opts.maxMinutes} budget used up`), Math.max(1000, RUN_DEADLINE - Date.now() + 15000)).unref();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void shutdown(130, sig));
process.on('uncaughtException', (e) => {
  console.error(e);
  void shutdown(2, 'uncaught exception');
});
process.on('unhandledRejection', (e) => console.error('[walkthrough] unhandled rejection (continuing):', e?.message ?? e));

function portOpen(port, host = '127.0.0.1') {
  return new Promise((done) => {
    const s = net.connect({ port, host });
    const end = (v) => {
      s.destroy();
      done(v);
    };
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
    s.setTimeout(1000, () => end(false));
  });
}

async function waitPort(port, child, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child && !alive(child)) throw new Error(`${child.label} exited (code ${child.exitCode}) before port ${port} opened; see ${child.logPath}`);
    if (await portOpen(port)) return Date.now() - t0;
    await sleep(250);
  }
  throw new Error(`port ${port} did not open within ${timeoutMs} ms; see ${child?.logPath ?? 'the server log'}`);
}

async function fetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function startServers() {
  for (const port of [API_PORT, WEB_PORT]) {
    if (await portOpen(port)) throw new Error(`port ${port} is already in use: stop that process, or pass --base-url to drive it`);
  }
  let dataEnv = {};
  if (!opts.repoData) {
    // A fresh database per invocation keeps runs comparable ("no history yet");
    // the stadium folder is kept so an import is not repeated needlessly.
    mkdirSync(SERVER_DIR, { recursive: true });
    for (const f of ['gameday.db', 'gameday.db-wal', 'gameday.db-shm']) rmSync(join(SERVER_DIR, f), { force: true });
    dataEnv = { DB_PATH: join(SERVER_DIR, 'gameday.db'), STADIUM_DIR: join(SERVER_DIR, 'stadiums') };
  }
  const t0 = Date.now();
  const server = spawnNode('server', join(REPO, 'server', 'src', 'index.ts'), [], REPO, { PORT: String(API_PORT), ...dataEnv });
  const viteBin = [join(REPO, 'app', 'node_modules', 'vite', 'bin', 'vite.js'), join(REPO, 'node_modules', 'vite', 'bin', 'vite.js')].find((p) => existsSync(p));
  if (!viteBin) throw new Error('vite is not installed: run npm install in the repo');
  const vite = spawnNode('vite', viteBin, ['--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'], join(REPO, 'app'), {});
  const apiMs = await waitPort(API_PORT, server, 60000);
  const webMs = await waitPort(WEB_PORT, vite, 90000);
  // Through Vite, which proves the /api proxy works too.
  const health = await fetchJson(`${BASE}/api/health`);
  const models = { kev8009: await portOpen(8009), fm8080: await portOpen(8080) };
  log(`servers up: api ${apiMs} ms, vite ${webMs} ms, total ${Date.now() - t0} ms; kev ${models.kev8009 ? 'up' : 'down'}, fm ${models.fm8080 ? 'up' : 'down'}`);
  return { apiMs, webMs, totalMs: Date.now() - t0, health, models, isolatedData: !opts.repoData, viteBin };
}

async function loadChromium() {
  const root = process.env.GD_PLAYWRIGHT_CORE;
  if (!root) throw new Error('GD_PLAYWRIGHT_CORE is not set: source /projects/sandbox/.kiro/env.sh');
  if (!process.env.GD_CHROMIUM) throw new Error('GD_CHROMIUM is not set: source /projects/sandbox/.kiro/env.sh');
  const mod = await import(pathToFileURL(join(root, 'index.js')).href);
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error(`no chromium export in ${root}`);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  return { chromium, version };
}

// ── Screenshot budget, shared by every flow in every invocation ──────
const budget = { cap: opts.shotCap, used: 0 };
function countAuditShots() {
  try {
    return readdirSync(SHOTS).filter((f) => /^audit-.*\.jpg$/.test(f)).length;
  } catch {
    return 0;
  }
}

// ── In-page probes (each runs inside the browser, so self-contained) ──
function INIT_SCRIPT({ skipSignIn }) {
  try {
    if (skipSignIn) sessionStorage.setItem('gd-demo-seen', '1');
  } catch {
    // about:blank popups have no storage
  }
  window.__gdLong = { count: 0, total: 0, max: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const g = window.__gdLong;
        g.count++;
        g.total += e.duration;
        g.max = Math.max(g.max, e.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // no long-task API
  }
  // The after-action report opens a popup and prints it. Headless printing
  // must not block the app, so the popup's print() is stubbed and the window
  // is kept for the harness to read.
  const open = window.open;
  window.open = function (...args) {
    const w = open.apply(this, args);
    if (w) {
      try {
        w.print = () => {
          window.__gdPrinted = (window.__gdPrinted || 0) + 1;
        };
        window.__gdPopup = w;
      } catch {
        // cross-origin popup: leave it alone
      }
    }
    return w;
  };
}

const READ_STATE = () => {
  const g = window.gameday;
  if (!g) return null;
  return {
    mapId: g.mapId,
    incident: g.incident,
    weather: g.weather,
    traffic: g.traffic,
    allDone: g.allDone,
    savedComparison: g.savedComparison,
    briefing: g.briefing,
    runs: (g.runs || []).map((r) => ({ label: r.label, ready: r.ready, t: r.t, frames: r.frames, fallbacks: r.fallbacksSoFar, scorecard: r.scorecard })),
  };
};

const WEBGL_PROBE = () => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const scene = window.gamedayScene;
  const out = { canvases: document.querySelectorAll('canvas').length, sceneRenderer: !!(scene && scene.app), webgl: false };
  if (!gl) return out;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ...out,
    webgl: true,
    version: gl.getParameter(gl.VERSION),
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
};

const MEASURE_FPS = async (ms) => {
  let frames = 0;
  let worst = 0;
  const t0 = performance.now();
  let last = t0;
  const long0 = { ...(window.__gdLong || { count: 0, total: 0 }) };
  await new Promise((done) => {
    const tick = (now) => {
      frames++;
      worst = Math.max(worst, now - last);
      last = now;
      if (now - t0 < ms) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  const dur = performance.now() - t0;
  const long1 = window.__gdLong || { count: 0, total: 0 };
  return {
    fps: Number(((frames * 1000) / dur).toFixed(1)),
    worstFrameMs: Math.round(worst),
    longTasks: long1.count - long0.count,
    longTaskMs: Math.round(long1.total - long0.total),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  };
};

/**
 * Point the 3D camera at a fan, officer or vehicle and return the screen point
 * to click. Uses the scene the app publishes for unattended checks
 * (window.gamedayScene); TypeScript "private" members are plain properties at
 * run time. Projection is the scene's own: sx = x - y, sy = (x + y) / 2 - h.
 */
const AIM_3D = ([kind, o]) => {
  const scene = window.gamedayScene;
  const host = document.querySelector('.crowd-host');
  if (!scene || !host) return { ok: false, why: 'no 3D scene mounted' };
  if (!scene.app) return { ok: false, why: '3D scene has no renderer (WebGL init failed?)' };
  const rect = host.getBoundingClientRect();
  const now = performance.now();
  let target = null;
  if (kind === 'officer') {
    const list = scene.officerPositions(now).filter((x) => x.x >= 0);
    const pick = o.id ? list.find((x) => x.id === o.id) : list[o.index ?? 0];
    if (pick) target = { x: pick.x, y: pick.y, h: o.h ?? 1.32, id: pick.id, unit: pick.unit, state: pick.state, officers: list.length };
  } else if (kind === 'dot') {
    const cur = scene.cur;
    const want = o.states ?? [2, 3];
    let skip = o.skip ?? 0;
    for (let i = 0; cur && i < cur.x.length && !target; i++) {
      if (!want.includes(cur.state[i])) continue;
      const p = scene.positionOf(i, now);
      if (!p) continue;
      if (skip-- > 0) continue;
      target = { x: p.x, y: p.y, h: o.h ?? 1.3, id: i, state: cur.state[i] };
    }
  } else if (kind === 'vehicle') {
    const list = window.gameday?.vehiclesIn?.(o.run ?? 0, o.state ?? 'parked') ?? [];
    const v = list[Math.min(o.index ?? 0, list.length - 1)];
    if (v) target = { x: v.x, y: v.y, h: o.h ?? 0.7, id: v.i, kind: v.kind, inState: list.length };
  }
  if (!target) return { ok: false, why: `no ${kind} to aim at` };
  const lift = typeof scene.liftAt === 'function' ? scene.liftAt(target.x, target.y) : 0;
  const sx = target.x - target.y;
  const sy = (target.x + target.y) / 2 - (target.h + lift);
  const scale = o.scale ?? 14;
  const fx = o.fx ?? 0.5;
  const fy = o.fy ?? 0.55;
  if (typeof scene.setFollowing === 'function') scene.setFollowing(false);
  scene.cam.scale = scale;
  scene.cam.x = rect.width * fx - sx * scale;
  scene.cam.y = rect.height * fy - sy * scale;
  const px = rect.left + rect.width * fx;
  const py = rect.top + rect.height * fy;
  const el = document.elementFromPoint(px, py);
  return {
    ok: true,
    target,
    px: Math.round(px),
    py: Math.round(py),
    hit: el ? `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''}` : null,
    onCanvas: el?.tagName === 'CANVAS',
  };
};

/** Scroll the nearest scrolling ancestor so `sel` sits at its top. */
const SCROLL_TO = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight) {
      p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - 8;
      return true;
    }
  }
  el.scrollIntoView({ block: 'start' });
  return true;
};

/** How much is in the side rail: scroll screens, controls, headings, words. */
const RAIL_METRICS = () => {
  const body = document.querySelector('.rail-body') || document.querySelector('.side');
  if (!body) return null;
  return {
    screens: Number((body.scrollHeight / Math.max(1, body.clientHeight)).toFixed(1)),
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
    controls: body.querySelectorAll('button, input, select, textarea').length,
    headings: body.querySelectorAll('h2, h3, h4').length,
    infoTips: body.querySelectorAll('.info').length,
    words: body.innerText.split(/\s+/).filter(Boolean).length,
  };
};

/**
 * Heuristic layout and accessibility checks on what is on screen: horizontal
 * overflow, target sizes, unnamed controls, text sizes, and approximate text
 * contrast (first opaque ancestor background; canvases and images ignored).
 */
const LAYOUT_AUDIT = () => {
  const vw = innerWidth;
  const vh = innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  };
  const nameOf = (el) =>
    (
      el.getAttribute('aria-label') ||
      (el.labels && [...el.labels].map((l) => l.innerText).join(' ')) ||
      el.getAttribute('title') ||
      el.innerText ||
      el.value ||
      el.getAttribute('placeholder') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  const desc = (el) =>
    `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''} "${nameOf(el).slice(0, 40)}"`;
  const ctrls = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=tab], [tabindex]:not([tabindex="-1"])')].filter(visible);
  const sized = ctrls.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, w: r.width, h: r.height };
  });
  const under24 = sized.filter((s) => s.w < 24 || s.h < 24);
  const under44 = sized.filter((s) => s.w < 44 || s.h < 44);
  const unnamed = ctrls.filter((el) => !nameOf(el));
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let total = 0;
  let lt12 = 0;
  let lt14 = 0;
  let low = 0;
  let unknown = 0;
  const lowSamples = [];
  const fontHist = {};
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize);
    total++;
    fontHist[Math.round(px)] = (fontHist[Math.round(px)] || 0) + 1;
    if (px < 12) lt12++;
    if (px < 14) lt14++;
    const fg = parse(cs.color);
    if (!fg) {
      unknown++;
      continue;
    }
    const bg = bgOf(el);
    const a = fg.a;
    const mix = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
    const L1 = lum(mix);
    const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) {
      low++;
      if (lowSamples.length < 12) lowSamples.push(`${ratio.toFixed(2)}:1 at ${Math.round(px)}px "${n.nodeValue.trim().slice(0, 40)}"`);
    }
  }
  const doc = document.scrollingElement;
  return {
    viewport: [vw, vh],
    overflowX: doc.scrollWidth > vw + 1,
    scrollWidth: doc.scrollWidth,
    scrollHeight: doc.scrollHeight,
    controls: ctrls.length,
    under24px: under24.length,
    under44px: under44.length,
    under24Samples: under24.slice(0, 10).map((s) => `${desc(s.el)} ${Math.round(s.w)}x${Math.round(s.h)}`),
    unnamed: unnamed.length,
    unnamedSamples: unnamed.slice(0, 10).map(desc),
    text: { elements: total, under12px: lt12, under14px: lt14, fontHist },
    lowContrast: { count: low, unknownColour: unknown, samples: lowSamples },
  };
};

const FOCUSABLE_COUNT = () =>
  [...document.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden';
  }).length;

const FOCUS_INFO = () => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { tag: 'BODY' };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}` : null;
  const shadow = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow.slice(0, 60) : null;
  const inViewport = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const top = inViewport ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  const obscured = inViewport && !!top && !(top === el || el.contains(top) || top.contains(el));
  const region = el.closest('.demo-access')
    ? 'dialog'
    : el.closest('header')
      ? 'header'
      : el.closest('.side')
        ? 'rail'
        : el.closest('.canvas-wrap')
          ? 'map'
          : el.closest('main')
            ? 'main'
            : 'other';
  return {
    tag: el.tagName,
    type: el.getAttribute('type'),
    role: el.getAttribute('role'),
    cls: typeof el.className === 'string' ? el.className.slice(0, 50) : '',
    name,
    rect: [r.x, r.y, r.width, r.height].map(Math.round),
    outline,
    shadow,
    inViewport,
    obscured,
    obscuredBy: obscured ? `${top.tagName.toLowerCase()}.${typeof top.className === 'string' ? top.className.split(' ')[0] : ''}` : null,
    region,
  };
};

// ── Page helpers ─────────────────────────────────────────────────────
const readState = (page) => page.evaluate(READ_STATE);
const compactState = (s) =>
  s && {
    mapId: s.mapId,
    incident: s.incident,
    weather: s.weather,
    allDone: s.allDone,
    runs: s.runs.map((r) => ({ label: r.label, ready: r.ready, t: r.t, frames: r.frames, fallbacks: r.fallbacks, done: !!r.scorecard })),
  };

async function transportText(page) {
  return (await page.locator('.controls.transport button.go.play').innerText({ timeout: 5000 })).trim();
}
async function play(page) {
  const text = await transportText(page);
  if (/^(Run all three plans|Resume)$/.test(text)) await page.locator('.controls.transport button.go.play').click();
  return text;
}
async function pause(page) {
  const text = await transportText(page).catch(() => '');
  if (text === 'Pause') await page.locator('.controls.transport button.go.play').click();
  return text;
}
async function setSpeed(page, speed) {
  await page.locator('.speed button', { hasText: `${speed}×` }).click();
}
async function clickView(page, label) {
  await page.locator('.view-toggle button', { hasText: new RegExp(`^${label}$`) }).click();
}
async function railTab(page, label) {
  await page.locator('.rail-tabs [role=tab]', { hasText: label }).first().click();
  await sleep(400);
}
async function scrollRail(page, selector) {
  return page.evaluate(SCROLL_TO, selector);
}
/** What is drawn on top at the centre of an element, after scrolling it into view. */
const HIT_PROBE = (el) => {
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const d = (e) => (e ? `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.split(' ').filter(Boolean).join('.') : ''}` : null);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height), top: d(top), onTarget: !!top && (top === el || el.contains(top)) };
};

/**
 * Tap a control the way a phone user would, and say whether that worked.
 * Playwright's own hit test runs first; when another element is drawn over the
 * control, that is recorded as a failed check, and the control is then
 * clicked through the DOM so the rest of the flow still gets its evidence.
 */
async function tapControl(f, loc, name) {
  await loc.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await loc.isEnabled())) {
    f.check(`"${name}" is enabled when the officer needs it`, false, 'disabled');
    return { name, enabled: false };
  }
  const probe = await loc.evaluate(HIT_PROBE).catch((e) => ({ error: e.message }));
  let tap = 'ok';
  try {
    await loc.tap({ timeout: 6000 });
  } catch (e) {
    const m = /<([^>]+)>[^<]*?(?:<\/\w+>)?[^\n]*intercepts pointer events/.exec(e.message);
    tap = `failed: ${m ? `<${m[1].slice(0, 80)}> intercepts pointer events` : e.message.split('\n')[0]}`;
  }
  const ok = tap === 'ok' || probe.onTarget === true;
  f.check(`"${name}" can be tapped where it is drawn (phone)`, ok, `playwright tap ${tap}; on top at its centre: ${probe.top ?? probe.error}`);
  if (tap !== 'ok') await loc.evaluate((el) => el.click());
  return { name, tap, probe, via: tap === 'ok' ? 'tap' : 'dom click (fallback)' };
}

/**
 * What makes a phone zoom the page out. Mobile Chrome widens the layout
 * viewport to fit content that will not shrink, so pin <html> to the device
 * width for a moment: whatever still sticks out is the culprit (outermost
 * element reported), then restore the page.
 */
const OVERFLOW_CULPRITS = (deviceWidth) => {
  const before = { innerWidth, scrollWidth: document.documentElement.scrollWidth, visualScale: window.visualViewport ? Number(window.visualViewport.scale.toFixed(3)) : null };
  const html = document.documentElement;
  const prev = html.style.width;
  html.style.width = `${deviceWidth}px`;
  const out = [];
  try {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= deviceWidth + 1) continue;
      const p = el.parentElement?.getBoundingClientRect();
      if (p && p.width > 0 && p.right > deviceWidth + 1) continue; // the outermost only
      out.push(`${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''} ${Math.round(r.width)}px wide, right=${Math.round(r.right)} "${(el.innerText || '').replace(/\s+/g, ' ').slice(0, 50)}"`);
      if (out.length >= 10) break;
    }
  } finally {
    html.style.width = prev;
  }
  return { ...before, culprits: out };
};

async function clickSlider(page, fraction) {
  const box = await page.locator('.replay input[type=range]').boundingBox();
  if (!box) throw new Error('no replay slider');
  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
}

// ── One flow's run: context, steps, checks, artifacts ────────────────
class FlowRun {
  constructor(def) {
    this.def = def;
    this.dir = join(OUT, def.name);
    mkdirSync(this.dir, { recursive: true });
    this.n = 0;
    this.t0 = Date.now();
    this.consoleLog = [];
    this.summary = {
      flow: def.name,
      title: def.title,
      startedAt: new Date().toISOString(),
      status: 'running',
      baseUrl: BASE,
      options: { speed: opts.speed, timebox: opts.timebox },
      viewport: def.viewport ?? DESKTOP,
      steps: [],
      checks: [],
      notes: [],
      timings: {},
      metrics: {},
      console: { errors: 0, warnings: 0 },
      pageErrors: [],
      requestFailures: [],
      httpErrors: [],
      workers: { created: 0, closed: 0 },
      shots: [],
    };
  }

  elapsed() {
    return Date.now() - this.t0;
  }
  note(text) {
    this.summary.notes.push(text);
    log(`  · ${text}`);
  }
  timing(name, ms) {
    this.summary.timings[name] = ms;
  }
  check(name, ok, detail = '') {
    this.summary.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) });
    log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${String(detail).slice(0, 160)})` : ''}`);
  }

  async open({ path = OHIO, skipSignIn = true, colorScheme = 'dark', viewport = this.def.viewport ?? DESKTOP, mobile = false, dsf = 1 } = {}) {
    this.summary.viewport = viewport;
    this.context = await browser.newContext({ viewport, deviceScaleFactor: dsf, isMobile: mobile, hasTouch: mobile, colorScheme, acceptDownloads: true });
    await this.context.addInitScript(INIT_SCRIPT, { skipSignIn });
    const page = await this.context.newPage();
    page.setDefaultTimeout(15000);
    this.page = page;
    page.on('console', (m) => {
      const type = m.type();
      if (type !== 'error' && type !== 'warning') return;
      if (type === 'error') this.summary.console.errors++;
      else this.summary.console.warnings++;
      if (this.consoleLog.length < 400) this.consoleLog.push({ atMs: this.elapsed(), type, text: m.text().slice(0, 1500), where: m.location()?.url?.replace(BASE, '') });
    });
    page.on('pageerror', (e) => this.summary.pageErrors.push({ atMs: this.elapsed(), message: String(e.message).slice(0, 800), stack: String(e.stack ?? '').slice(0, 1200) }));
    page.on('requestfailed', (r) => {
      if (this.summary.requestFailures.length < 100) this.summary.requestFailures.push({ atMs: this.elapsed(), url: r.url().replace(BASE, ''), error: r.failure()?.errorText });
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && this.summary.httpErrors.length < 100) this.summary.httpErrors.push({ atMs: this.elapsed(), url: r.url().replace(BASE, ''), status: r.status() });
    });
    page.on('worker', (w) => {
      this.summary.workers.created++;
      w.on('close', () => this.summary.workers.closed++);
    });
    page.on('crash', () => this.note('PAGE CRASHED'));
    const t = Date.now();
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 90000 });
    this.timing('navigate', Date.now() - t);
    this.summary.url = BASE + path;
    return page;
  }

  /** Run one named step. Errors are recorded, never thrown: the flow carries on. */
  async step(name, fn, { shot = false, aria = true, text = true } = {}) {
    const id = `${String(++this.n).padStart(2, '0')}-${slug(name)}`;
    const rec = { id, name, status: 'ok', atMs: this.elapsed() };
    const t = Date.now();
    log(`→ ${this.def.name}/${id}`);
    try {
      const out = fn ? await fn(this.page, rec) : undefined;
      if (out !== undefined) rec.result = out;
    } catch (e) {
      rec.status = 'error';
      rec.error = String(e?.message ?? e).slice(0, 1500);
      log(`  ✗ ${rec.error.split('\n')[0]}`);
    }
    rec.ms = Date.now() - t;
    if (this.page && !this.page.isClosed()) {
      try {
        rec.state = compactState(await within(5000, readState(this.page), 'state read'));
      } catch {
        rec.state = null;
      }
      if (text) rec.text = await this.dumpText(id);
      if (aria) rec.aria = await this.dumpAria(id);
      const wantShot = typeof shot === 'function' ? shot(rec) : shot;
      if (wantShot) rec.shot = await this.shot(id);
    }
    this.summary.steps.push(rec);
    this.flush();
    return rec;
  }

  async dumpText(id) {
    try {
      const text = await within(10000, this.page.evaluate(() => document.body.innerText), 'innerText');
      const file = join(this.dir, `${id}.txt`);
      writeFileSync(file, text);
      return file;
    } catch (e) {
      return `failed: ${e.message}`;
    }
  }

  async dumpAria(id) {
    try {
      const page = this.page;
      const snap = typeof page.ariaSnapshot === 'function' ? page.ariaSnapshot({ timeout: 15000 }) : page.locator('body').ariaSnapshot({ timeout: 15000 });
      const yaml = await within(20000, snap, 'aria snapshot');
      const file = join(this.dir, `${id}.aria.yaml`);
      writeFileSync(file, yaml);
      return file;
    } catch (e) {
      return `failed: ${e.message.split('\n')[0]}`;
    }
  }

  async shot(id) {
    if (!opts.shots) return null;
    if (budget.used >= budget.cap) {
      this.note(`screenshot ${id} skipped: the ${budget.cap}-screenshot cap is reached`);
      return null;
    }
    const file = join(SHOTS, `audit-${this.def.name}-${id}.jpg`);
    try {
      await this.page.screenshot({ path: file, type: 'jpeg', quality: 70, timeout: 30000 });
      budget.used++;
      this.summary.shots.push(file);
      return file;
    } catch (e) {
      this.note(`screenshot ${id} failed: ${e.message.split('\n')[0]}`);
      return null;
    }
  }

  async layout(label) {
    try {
      const audit = await within(15000, this.page.evaluate(LAYOUT_AUDIT), 'layout audit');
      this.summary.metrics[`layout-${label}`] = audit;
      return audit;
    } catch (e) {
      return { error: e.message };
    }
  }

  flush() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'summary.json'), JSON.stringify({ ...this.summary, elapsedMs: this.elapsed() }, null, 2));
    writeFileSync(join(this.dir, 'console.json'), JSON.stringify(this.consoleLog, null, 2));
  }

  async close() {
    const failed = this.summary.checks.filter((c) => !c.ok).length;
    const errored = this.summary.steps.filter((s) => s.status === 'error').length;
    if (this.summary.status === 'running') this.summary.status = errored ? 'error' : failed ? 'check-failed' : 'ok';
    this.summary.endedAt = new Date().toISOString();
    this.summary.durationMs = this.elapsed();
    this.flush();
    try {
      await within(10000, this.context?.close() ?? Promise.resolve(), 'context close');
    } catch {
      // a crashed page can refuse to close; the browser goes at the end anyway
    }
  }
}

// ── Shared flow pieces ───────────────────────────────────────────────
async function waitHeader(f, timeout = 120000) {
  const t = Date.now();
  const ok = await poll(() => f.page.evaluate(() => {
    const h = document.querySelector('header.top h1')?.textContent;
    return h && h !== 'Loading stadium' ? h : null;
  }), { timeout, interval: 400 });
  f.timing('map-loaded', Date.now() - t);
  f.check('stadium map loads', !!ok, ok ?? 'still "Loading stadium"');
  return ok;
}

async function waitReady(f, timeout = 150000, extra = () => true) {
  const t = Date.now();
  const ok = await poll(async () => {
    const s = await readState(f.page);
    return s && s.mapId && s.runs.length === 3 && s.runs.every((r) => r.ready) && extra(s) ? s : null;
  }, { timeout, interval: 500 });
  f.timing(`runs-ready-${Object.keys(f.summary.timings).filter((k) => k.startsWith('runs-ready')).length + 1}`, Date.now() - t);
  if (!ok) f.check('three plan workers become ready', false, `not ready after ${timeout} ms`);
  return ok;
}

/** Let the run go until the slowest plan reaches simT (or all finish), sampling progress. */
async function runUntil(f, simT, timeoutMs, label, { stallMs = 60000 } = {}) {
  const t0 = Date.now();
  const samples = [];
  let last = null;
  let nextSample = 0;
  let stopped = null;
  let progressAt = Date.now();
  let lastT = null;
  const errors0 = f.summary.pageErrors.length;
  // Always read at least once, so a spent time box still reports where the run is.
  do {
    const e0 = Date.now();
    const s = await within(10000, readState(f.page), 'state read').catch(() => null);
    const evalMs = Date.now() - e0;
    if (s && s.runs.length) {
      last = s;
      const slowest = Math.min(...s.runs.map((r) => r.t));
      if (lastT === null || slowest > lastT) {
        lastT = slowest;
        progressAt = Date.now();
      }
      if (Date.now() >= nextSample) {
        const heapMB = await f.page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)).catch(() => null);
        samples.push({ wallS: Number(((Date.now() - t0) / 1000).toFixed(1)), t: s.runs.map((r) => r.t), done: s.runs.map((r) => !!r.scorecard), fallbacks: s.runs.map((r) => r.fallbacks), evalMs, heapMB });
        nextSample = Date.now() + 3000;
      }
      if (s.allDone) break;
      if (simT !== null && slowest >= simT) break;
    }
    // A run that has stopped advancing will not finish by waiting: say why and move on.
    const oom = f.summary.pageErrors.slice(errors0).find((e) => /allocation failed|out of memory/i.test(e.message));
    if (oom) {
      stopped = `page ran out of memory (${oom.message.slice(0, 80)})`;
      break;
    }
    if (f.page.isClosed()) {
      stopped = 'page closed or crashed';
      break;
    }
    if (Date.now() - progressAt > stallMs) {
      stopped = `no sim progress for ${Math.round(stallMs / 1000)} s (slowest plan stuck at t=${lastT})`;
      break;
    }
    await sleep(500);
  } while (Date.now() - t0 < timeoutMs);
  if (stopped) f.note(`${label}: stopped early, ${stopped}`);
  const first = samples[0];
  const end = samples[samples.length - 1];
  const speed = first && end && end.wallS > first.wallS ? (Math.min(...end.t) - Math.min(...first.t)) / (end.wallS - first.wallS) : null;
  f.summary.metrics[label] = {
    wallS: Number(((Date.now() - t0) / 1000).toFixed(1)),
    targetSimT: simT,
    reachedSimT: last ? Math.min(...last.runs.map((r) => r.t)) : null,
    allDone: !!last?.allDone,
    stoppedEarly: stopped,
    simSecondsPerWallSecond: speed === null ? null : Number(speed.toFixed(1)),
    worstEvalMs: samples.reduce((m, s) => Math.max(m, s.evalMs), 0),
    peakHeapMB: samples.reduce((m, s) => Math.max(m, s.heapMB ?? 0), 0) || null,
    samples,
  };
  return last;
}

/**
 * Is the app still on screen? A render error with no error boundary unmounts
 * the whole React tree (seen after an out-of-memory error), and then every
 * locator below would wait out its full timeout for nothing.
 */
async function appUp(f) {
  if (!f.page || f.page.isClosed()) return false;
  return within(8000, f.page.evaluate(() => (document.querySelector('#root')?.children.length ?? 0) > 0 && !!document.querySelector('.replay')), 'render probe').catch(() => false);
}

/** A fresh Ohio Stadium page with the map loaded and all three workers ready. */
async function openOhio(f, path = OHIO, extra = {}) {
  await f.open({ path, ...extra });
  await waitHeader(f);
  const ready = await waitReady(f);
  if (!f.summary.metrics.webgl) f.summary.metrics.webgl = await f.page.evaluate(WEBGL_PROBE).catch((e) => ({ error: e.message }));
  return ready;
}

// ── Flows ────────────────────────────────────────────────────────────
async function flowStart(f) {
  if (!opts.repoData && !opts.baseUrl) rmSync(join(SERVER_DIR, 'stadiums'), { recursive: true, force: true });
  await f.open({ path: '/', skipSignIn: false });
  await f.step('sign-in-dialog', async (p) => {
    await p.locator('.demo-access').waitFor({ timeout: 30000 });
    await sleep(1600); // the 1.1 s "radio sync" intro
    const tab = [];
    for (let i = 0; i < 6; i++) {
      await p.keyboard.press('Tab');
      tab.push((await p.evaluate(FOCUS_INFO)).name);
    }
    return { dialog: await p.locator('.demo-access').innerText(), tabCycle: tab };
  }, { shot: true });
  await f.step('skip-to-start-screen', async (p) => {
    await p.keyboard.press('Escape');
    await p.locator('.start-card').waitFor({ timeout: 20000 });
    await poll(async () => (await p.locator('.start-maps button').count()) > 0, { timeout: 15000 });
    const maps = await p.locator('.start-maps button').allInnerTexts();
    f.check('start screen lists stadiums', maps.length > 0, maps.join(' | '));
    await f.layout('start');
    return { maps };
  }, { shot: true });
  let hits = [];
  await f.step('search-beaver-stadium', async (p) => {
    await p.locator('.start-search input').fill('Beaver Stadium');
    const t = Date.now();
    await p.locator('.start-search button').click();
    const outcome = await poll(async () => {
      if (await p.locator('.start-hits li').count()) return 'hits';
      if (await p.locator('.start-card p.error').count()) return 'error';
      if (await p.getByText('No stadiums by that name').count()) return 'none';
      return null;
    }, { timeout: 45000, interval: 400 });
    f.timing('search', Date.now() - t);
    hits = await p.locator('.start-hits li').allInnerTexts();
    const error = (await p.locator('.start-card p.error').allInnerTexts()).join(' ');
    f.check('OpenStreetMap stadium search answers', outcome === 'hits', outcome ?? 'timeout');
    return { outcome: outcome ?? 'timeout', hits, error };
  }, { shot: true });
  if (!hits.length) {
    f.note('No search hits, so the import was not attempted.');
    return;
  }
  let mapId = null;
  await f.step('import-first-hit', async (p, rec) => {
    const t = Date.now();
    await p.locator('.start-hits li').first().getByRole('button', { name: /Import/ }).click();
    const stages = [];
    let lastText = '';
    let progressShot = false;
    let outcome = null;
    while (Date.now() - t < 300000) {
      if (/[?&]map=osm-/.test(p.url())) {
        outcome = 'imported';
        break;
      }
      const err = await p.locator('.start-card p.error').allInnerTexts().catch(() => []);
      if (err.length) {
        outcome = 'error';
        stages.push({ ms: Date.now() - t, text: `error: ${err.join(' ')}` });
        break;
      }
      const prog = (await p.locator('.start-progress').innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
      if (prog && prog !== lastText) {
        stages.push({ ms: Date.now() - t, text: prog });
        lastText = prog;
      }
      if (!progressShot && prog && Date.now() - t > 5000) {
        progressShot = true;
        await f.shot(`${rec.id}-progress`);
      }
      await sleep(600);
    }
    f.timing('import', Date.now() - t);
    mapId = outcome === 'imported' ? new URL(p.url()).searchParams.get('map') : null;
    f.check('stadium import finishes', outcome === 'imported', outcome ?? 'timed out after 300 s');
    // Keep only stage changes, not every byte count.
    const compact = stages.filter((s, i) => i === 0 || s.text.replace(/[\d.]+ MB/, '') !== stages[i - 1].text.replace(/[\d.]+ MB/, '') || i === stages.length - 1);
    return { outcome: outcome ?? 'timeout', mapId, stages: compact };
  }, { shot: (rec) => rec.result?.outcome !== 'imported' });
  if (!mapId) return;
  await f.step('imported-stadium-running', async (p) => {
    await waitHeader(f, 150000);
    const ready = await waitReady(f, 180000);
    if (!ready) throw new Error('imported stadium never became ready');
    await setSpeed(p, opts.speed);
    await play(p);
    await runUntil(f, -1800, 60000, 'imported-run');
    await pause(p);
    await sleep(1200);
    return { header: await p.locator('header.top').innerText(), webgl: await p.evaluate(WEBGL_PROBE) };
  }, { shot: true });
}

async function flowViews(f) {
  await f.open({ path: `${OHIO}&autorun=1` });
  await f.step('load-with-autorun', async (p) => {
    await waitHeader(f);
    await waitReady(f);
    const started = await poll(async () => (await readState(p))?.runs.some((r) => r.frames > 1), { timeout: 45000 });
    f.check('?autorun=1 starts the three runs without a click', !!started);
    f.summary.metrics.webgl = await p.evaluate(WEBGL_PROBE);
    f.check('WebGL is available headless (SwiftShader)', f.summary.metrics.webgl.webgl, f.summary.metrics.webgl.renderer ?? 'no context');
    f.check('3D close-up renderer initialised', f.summary.metrics.webgl.sceneRenderer);
    return { webgl: f.summary.metrics.webgl };
  });
  await f.step('run-to-20-min-before-kickoff', async (p) => {
    await setSpeed(p, opts.speed);
    await runUntil(f, -1200, 150000, 'views-run');
  });
  const views = [
    ['3D', '3d'],
    ['2D plan', '2d-plan'],
    ['All three', 'all-three'],
  ];
  for (const [label, key] of views) {
    await f.step(`${key}-dark`, async (p) => {
      await clickView(p, label);
      await sleep(2000);
      await play(p);
      const fps = await within(20000, p.evaluate(MEASURE_FPS, 4000), 'fps');
      await pause(p);
      await sleep(1500);
      f.summary.metrics[`fps-${key}`] = fps;
      if (key === '3d') await f.layout('main-dark');
      return { fps, onScreen: await p.locator('.map-title').innerText().catch(() => '') };
    }, { shot: true });
  }
  await f.step('switch-to-light-theme', async (p) => {
    await p.locator('button.theme-toggle').first().click();
    await sleep(1000);
    await f.layout('main-light');
    return { theme: await p.evaluate(() => document.documentElement.dataset.theme) };
  }, { shot: true }); // still on "All three"
  for (const [label, key] of [views[1], views[0]]) {
    await f.step(`${key}-light`, async (p) => {
      await clickView(p, label);
      await sleep(2500);
    }, { shot: true });
  }
  await f.step('density-band-filter', async (p) => {
    const chip = p.locator('.band-bar .band-chip').nth(2);
    await chip.click();
    await sleep(800);
    const areas = await p.locator('.areas-panel').innerText().catch(() => '');
    await p.locator('.areas-panel button', { hasText: 'Show all colours' }).click().catch(() => {});
    return { areas };
  });
}

async function flowTabs(f) {
  await openOhio(f, `${OHIO}&view=plan&weather=heat`);
  await f.step('url-params', async (p) => {
    const view = await p.locator('.view-toggle button.on').innerText();
    const weather = await p.locator('.controls.transport select').first().inputValue();
    f.check('?view=plan opens the 2D plan', view === '2D plan', view);
    f.check('?weather=heat selects the heat scenario', weather === 'heat', weather);
    return { view, weather };
  });
  await f.step('run-to-10-min-before-kickoff', async (p) => {
    await setSpeed(p, opts.speed);
    await play(p);
    await runUntil(f, -600, 150000, 'tabs-run');
    await pause(p);
    await sleep(1000);
  });
  for (const tab of ['Brief', 'Orders', 'Plans', 'Gates', 'Map key', 'About']) {
    await f.step(`tab-${tab}`, async (p) => {
      await railTab(p, tab);
      const metrics = await p.evaluate(RAIL_METRICS);
      f.summary.metrics[`rail-${slug(tab)}`] = metrics;
      return { metrics, tabs: await p.locator('.rail-tabs').innerText() };
    }, { shot: true });
  }
  await f.step('brief-real-conditions-panel', async (p) => {
    await railTab(p, 'Brief');
    await p.locator('details.feed summary').click();
    await sleep(400);
    return { text: await p.locator('details.feed').innerText() };
  });
  await f.step('brief-build-three-plans', async (p) => {
    const before = await p.evaluate(() => [...document.querySelectorAll('.plan-card h3')].map((h) => h.textContent));
    await p.getByRole('button', { name: 'Build three plans from this' }).click();
    await waitReady(f, 150000);
    await railTab(p, 'Plans');
    const after = await p.locator('.plan-card h3').allInnerTexts();
    f.check('"Build three plans from this" loads three new plans', after.length === 3, after.join(' | '));
    return { before, after };
  });
}

const INCIDENTS = {
  surge: { index: 0, kind: 'gate_surge', at: 0, timebox: 180 },
  lightning: { index: 1, kind: 'lightning_delay', at: 1800, timebox: 180 },
  package: { index: 2, kind: 'suspicious_package', at: 12600, timebox: 360 },
  // Not an incident the brief lists, but the only egress run that fits a time
  // box: it opens five minutes before the final whistle.
  gameEnd: { index: 3, kind: 'game_end', at: 12600, timebox: 180, fewerShots: true },
};

async function flowIncident(f, inc) {
  await openOhio(f);
  if (inc.index > 0) {
    await f.step('choose-situation', async (p) => {
      await p.locator('nav.situations button').nth(inc.index).click();
      // The restart happens in an effect after the click; give it a moment so
      // the old (still "ready") workers are not mistaken for the new ones.
      await sleep(1500);
      const ok = await waitReady(f, 150000, (s) => s.incident === inc.kind && s.runs.every((r) => r.frames <= 1));
      f.check(`situation switches to ${inc.kind}`, !!ok);
      return { situations: await p.locator('nav.situations').innerText() };
    });
  }
  const timebox = (opts.timebox ?? inc.timebox) * 1000;
  const deadline = Date.now() + timebox;
  await f.step('run-to-5-min-after-incident', async (p) => {
    await setSpeed(p, opts.speed);
    await play(p);
    const s = await runUntil(f, inc.at + 300, deadline - Date.now(), 'run-to-incident');
    f.check('run reaches 5 min after the incident inside the time box', s && Math.min(...s.runs.map((r) => r.t)) >= inc.at + 300, s ? Math.min(...s.runs.map((r) => r.t)) : 'no state');
    await clickView(p, 'All three');
    await sleep(3000);
    return { banner: await p.locator('.deciding, .alert-banner').allInnerTexts().catch(() => []) };
  }, { shot: !inc.fewerShots });
  await f.step('run-to-end', async (p) => {
    const s = await runUntil(f, null, Math.max(0, deadline - Date.now()), 'run-to-end');
    f.check('all three plans finish inside the time box', !!s?.allDone, s ? `slowest plan at t=${Math.min(...s.runs.map((r) => r.t))}` : 'no state');
    const rendered = await appUp(f);
    f.check('the app is still rendered (no blank page after an error)', rendered, `${f.summary.pageErrors.length} page errors`);
    f.summary.metrics.scorecards = s?.runs.map((r) => r.scorecard) ?? null;
    if (!s?.allDone) {
      if (rendered) await pause(p).catch(() => {});
      return { finished: false, rendered };
    }
    const briefing = await poll(() => p.evaluate(() => window.gameday?.briefing), { timeout: 40000 });
    f.summary.metrics.briefing = briefing;
    return { finished: true, briefing };
  });
  const finished = !!(await within(8000, readState(f.page), 'state read').catch(() => null))?.allDone;
  if (!(await appUp(f))) {
    // Nothing left to drive: keep one picture of the broken state and stop.
    await f.step('blank-app-after-error', async () => ({ pageErrors: f.summary.pageErrors.map((e) => e.message) }), { shot: true, aria: false });
    f.note('The app unmounted (blank page), so the verdict, ranking and replay steps were skipped.');
    return;
  }
  await f.step('plans-verdict', async (p) => {
    await railTab(p, 'Plans');
    await scrollRail(p, '.rail-body .verdict');
    return {
      verdict: await p.locator('.verdict').first().innerText().catch(() => ''),
      ranking: await p.locator('.ranking').first().innerText().catch(() => ''),
      metrics: await p.evaluate(RAIL_METRICS),
    };
  }, { shot: true });
  await f.step('plans-cards', async (p) => {
    await scrollRail(p, '.rail-body .plan-card');
  }, { shot: !inc.fewerShots });
  if (finished) {
    await f.step('rank-by-each-priority', async (p) => {
      // .ranking also holds the feedback form's "plan you would go with"
      // select, so pin the priority picker by its label (strict mode).
      const select = p.locator('.ranking label.priority select').first();
      const options = await select.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent })));
      const lines = {};
      for (const o of options) {
        await select.selectOption(o.value);
        await sleep(300);
        lines[o.label] = await p.locator('.ranking .best-line').first().innerText().catch(() => '');
      }
      await select.selectOption(options[0].value);
      return lines;
    });
  }
  await f.step('about-numbers', async (p) => {
    await railTab(p, 'About');
    return { about: await p.locator('.rail-body').innerText() };
  });
  await f.step('replay-scrub-to-middle', async (p) => {
    await railTab(p, 'Plans');
    await clickSlider(p, 0.5);
    await sleep(2000);
    return {
      label: await p.locator('.replay-label').innerText(),
      replaying: await p.locator('.replaying').count(),
      buttons: await p.locator('.replay button').allInnerTexts(),
    };
  }, { shot: inc.index === 0 });
  await f.step('back-to-live', async (p) => {
    await p.locator('.replay button', { hasText: 'Back to live' }).click().catch(() => {});
    await sleep(800);
    return { label: await p.locator('.replay-label').innerText() };
  });
  if (inc.index === 0 && finished) {
    await f.step('what-do-you-think-feedback', async (p) => {
      const fb = p.locator('.feedback');
      await fb.locator('select').selectOption('B');
      await fb.getByRole('button', { name: 'No', exact: true }).click();
      await fb.locator('textarea').fill('Audit run: would open Gate 2 earlier and hold officers at the hot gate.');
      await fb.getByRole('button', { name: 'Send', exact: true }).click();
      const thanks = await poll(async () => /Thanks, noted/.test(await fb.innerText()), { timeout: 10000 });
      f.check('commander feedback is recorded', !!thanks);
      return { after: await fb.innerText() };
    });
    await f.step('rewind-play-on-from-here', async (p) => {
      await clickSlider(p, 0.4);
      await sleep(1000);
      await p.locator('.replay button', { hasText: 'Play on from here' }).click();
      await sleep(3000);
      const s = await readState(p);
      f.check('finished results survive "Play on from here"', !!s?.allDone, `allDone=${s?.allDone}, scorecards=${s?.runs.filter((r) => r.scorecard).length}`);
      return { allDone: s?.allDone, verdict: await p.locator('.verdict').innerText().catch(() => '') };
    });
  }
}

async function flowPlanEditor(f) {
  await openOhio(f);
  await f.step('open-plan-a-editor', async (p) => {
    await railTab(p, 'Plans');
    await p.locator('.plan-card').first().getByRole('button', { name: 'Edit this plan' }).click();
    await sleep(500);
    await scrollRail(p, '.plan-card .plan-edit');
    return { steps: await p.locator('.plan-card').first().locator('.plan-editor .step').allInnerTexts() };
  }, { shot: true });
  await f.step('edit-a-step-and-add-a-step', async (p) => {
    const card = p.locator('.plan-card').first();
    const before = await card.locator('.plan-editor .step').count();
    await card.locator('.plan-editor .step .step-at input').first().fill('2');
    const counts = card.locator('.plan-editor .step .step-n input');
    if (await counts.count()) await counts.first().fill('4');
    const adder = card.locator('.step-adder');
    await adder.locator('select').first().selectOption('alert');
    await adder.locator('select').nth(1).selectOption('phone');
    await adder.locator('input[type=number]').first().fill('50');
    await adder.locator('input[type=text]').fill('Gate is busy. Use the next open gate.');
    await adder.locator('.step-at input').fill('1');
    await adder.getByRole('button', { name: 'Add step' }).click();
    const after = await card.locator('.plan-editor .step').count();
    f.check('StepAdder adds a step to the plan', after === before + 1, `${before} -> ${after}`);
    const restart = await p.getByRole('button', { name: 'Restart with my changes' }).count();
    f.check('"Restart with my changes" appears after an edit', restart > 0);
    await scrollRail(p, '.plan-card .step-adder');
    return { before, after, steps: await card.locator('.plan-editor .step').allInnerTexts() };
  }, { shot: true });
  await f.step('restart-with-changes', async (p) => {
    await p.getByRole('button', { name: 'Restart with my changes' }).click();
    await sleep(1000);
    await waitReady(f, 150000);
    const steps = await p.locator('.plan-card').first().locator('.plan-steps li').allInnerTexts();
    f.check('the restarted plan carries the added step', steps.some((s) => /Phone alert/i.test(s)), steps.join(' | '));
    return { steps };
  });
  await f.step('run-edited-plans-past-the-alert', async (p) => {
    await setSpeed(p, opts.speed);
    await play(p);
    await runUntil(f, 150, 150000, 'edited-run');
    await pause(p);
    await sleep(1200);
    const banner = await p.locator('.alert-banner').allInnerTexts();
    const steps = await p.locator('.plan-card').first().locator('.plan-steps li').allInnerTexts();
    // Each step's text spans lines ("Phone alert …\nafter 1 min\nreached 49,270 …").
    f.check('the added phone alert fires in the run', steps.some((s) => /Phone alert[\s\S]*?\breached\b/i.test(s)) || banner.length > 0, [...banner, ...steps].join(' | '));
    return { banner, steps };
  }, { shot: true });
  await f.step('reload-page', async (p) => {
    await p.reload({ waitUntil: 'domcontentloaded' });
    await waitHeader(f);
    await waitReady(f);
    await railTab(p, 'Plans');
    const steps = await p.locator('.plan-card').first().locator('.plan-steps li').allInnerTexts();
    f.check('plan edits survive a page reload', steps.some((s) => /Phone alert/i.test(s)), steps.join(' | '));
    return { steps };
  });
}

async function flowInspectors(f) {
  await openOhio(f);
  await f.step('run-to-15-min-before-kickoff', async (p) => {
    await setSpeed(p, opts.speed);
    await play(p);
    await runUntil(f, -900, 150000, 'inspect-run');
    await pause(p);
    await sleep(1500);
  });
  await f.step('click-a-fan', async (p) => {
    const aim = await p.evaluate(AIM_3D, ['dot', { states: [2, 3], skip: 40 }]);
    if (!aim.ok) throw new Error(aim.why);
    await sleep(800);
    await p.mouse.click(aim.px, aim.py);
    const panel = p.locator('.inspector').first();
    await panel.waitFor({ timeout: 8000 });
    await poll(async () => !/asking the worker/.test(await panel.innerText()), { timeout: 10000 });
    const text = await panel.innerText();
    f.check('clicking a fan opens the group inspector', /group of/.test(text), text.slice(0, 120));
    return { aim, text };
  }, { shot: true });
  await p_close(f);
  await f.step('click-a-vehicle', async (p) => {
    let result = null;
    for (const state of ['parked', 'stopped', 'driving']) {
      const aim = await p.evaluate(AIM_3D, ['vehicle', { state, index: 3 }]);
      if (!aim.ok) continue;
      await sleep(800);
      await p.mouse.click(aim.px, aim.py);
      if (await p.locator('.vehicle-inspector').waitFor({ timeout: 4000 }).then(() => true, () => false)) {
        result = { aim, state, text: await p.locator('.vehicle-inspector').innerText() };
        break;
      }
    }
    f.check('clicking a vehicle opens the vehicle inspector', !!result, result?.text.slice(0, 120) ?? 'no vehicle panel');
    return result;
  }, { shot: true });
  await p_close(f);
  await f.step('click-an-officer', async (p) => {
    const aim = await p.evaluate(AIM_3D, ['officer', { index: 2 }]);
    if (!aim.ok) throw new Error(aim.why);
    await sleep(800);
    await p.mouse.click(aim.px, aim.py);
    await p.locator('.officer-panel').waitFor({ timeout: 8000 });
    const text = await p.locator('.officer-panel').innerText();
    f.check('clicking an officer opens the officer panel', /Police officer/.test(text), text.slice(0, 120));
    return { aim, text };
  }, { shot: true });
  await f.step('officer-send-to-arms-a-map-pick', async (p) => {
    await p.locator('.officer-panel').getByRole('button', { name: 'Send to…' }).click();
    await sleep(500);
    const hint = await p.locator('.police-pick').innerText().catch(() => '');
    await p.keyboard.press('Escape');
    await sleep(400);
    const after = await p.locator('.police-pick').count();
    f.check('Esc cancels a pending map pick', after === 0);
    return { hint, pickAfterEsc: after };
  });
}

async function p_close(f) {
  await f.page.locator('.inspector header button[title=Close]').first().click({ timeout: 3000 }).catch(() => {});
  await sleep(300);
}

async function flowPolice(f) {
  await openOhio(f);
  await f.step('run-to-4-min-before-kickoff', async (p) => {
    await setSpeed(p, opts.speed);
    await play(p);
    await runUntil(f, -240, 150000, 'police-run');
    await setSpeed(p, 5);
  });
  const orders = f.page.locator('.police-orders');
  const sug = '.police-orders section[aria-label="Suggested responses"]';
  await f.step('orders-tab-suggestions', async (p) => {
    await railTab(p, 'Orders');
    const n = await poll(async () => {
      const m = /\((\d+)\)/.exec(await p.locator(`${sug} h3`).first().innerText());
      return m && Number(m[1]) > 0 ? Number(m[1]) : null;
    }, { timeout: 45000, interval: 1000 });
    f.check('dispatch suggestions appear during the surge', !!n, String(n));
    await scrollRail(p, sug);
    f.summary.metrics['rail-orders'] = await p.evaluate(RAIL_METRICS);
    return { suggestions: n, text: await p.locator(sug).innerText().catch(() => '') };
  }, { shot: true });
  await f.step('dispatch-first-suggestion', async (p) => {
    const btn = orders.getByRole('button', { name: 'Send and return' }).first();
    if (!(await btn.count())) throw new Error('no suggestion to accept');
    const what = await p.locator(`${sug} article`).first().innerText().catch(() => '');
    await btn.click();
    const logged = await poll(async () => /responding/i.test(await p.locator('.police-log').innerText()), { timeout: 20000 });
    f.check('an accepted suggestion lands in the order log', !!logged);
    return { what, log: (await p.locator('.police-log').innerText()).split('\n').slice(0, 6) };
  });
  await f.step('barricade-a-street', async (p) => {
    await orders.getByRole('button', { name: 'Barricade a street' }).click();
    const hint = await p.locator('.police-pick').innerText().catch(() => '');
    const tries = [];
    let placed = false;
    for (let i = 0; i < 5 && !placed; i++) {
      const aim = await p.evaluate(AIM_3D, ['vehicle', { state: i % 2 ? 'stopped' : 'driving', index: i * 9, h: 0, scale: 9 }]);
      tries.push({ ok: aim.ok, hit: aim.hit, why: aim.why, kind: aim.target?.kind });
      if (!aim.ok) continue;
      await sleep(500);
      await p.mouse.click(aim.px, aim.py);
      await sleep(1800);
      placed = (await p.locator('.police-barricades li').count()) > 0;
      if (!placed) tries[tries.length - 1].hint = await p.locator('.police-orders .warn').innerText().catch(() => '');
    }
    f.check('a street barricade can be placed by clicking the map', placed, JSON.stringify(tries).slice(0, 300));
    await orders.getByRole('button', { name: 'Cancel map pick' }).click().catch(() => {});
    return { hint, tries, list: await p.locator('.police-barricades').innerText().catch(() => '') };
  });
  await f.step('place-a-medical-marker', async (p) => {
    await orders.locator('select').filter({ has: p.locator('option[value="medical"]') }).selectOption('medical');
    await orders.getByRole('button', { name: 'Place marker on map' }).click();
    const aim = await p.evaluate(AIM_3D, ['dot', { states: [3], h: 0, scale: 9, fx: 0.38, fy: 0.62, skip: 120 }]);
    if (!aim.ok) throw new Error(aim.why);
    await sleep(500);
    await p.mouse.click(aim.px, aim.py);
    // hasText strings match case-insensitively, so look for the log line instead.
    const placed = await poll(async () => /Placed Medical tent marker/.test(await p.locator('.police-log').innerText()), { timeout: 15000 });
    f.check('a medical-tent marker can be placed', !!placed, placed ? '' : await p.locator('.police-orders .warn').innerText().catch(() => 'no log line'));
    return { aim: { hit: aim.hit }, placed: !!placed };
  }, { shot: true });
  await f.step('send-a-pa-alert', async (p) => {
    const sec = orders.locator('section', { has: p.locator('h3', { hasText: /^Alert$/ }) });
    await sec.locator('input[type=text]').fill('Gates 10 and 1 are open with short lines. Please use them.');
    await sec.getByRole('button', { name: 'Send', exact: true }).click();
    const ok = await poll(async () => /PA alert/.test(await p.locator('.police-log').innerText()), { timeout: 20000 });
    f.check('a PA alert is carried out and logged', !!ok);
  });
  await f.step('redirect-between-gates', async (p) => {
    const sec = orders.locator('section', { has: p.locator('h3', { hasText: /^Redirect$/ }) });
    const gates = await sec.locator('select').first().locator('option').allInnerTexts();
    await sec.locator('select').nth(1).selectOption({ index: Math.min(3, gates.length - 1) });
    await sec.getByRole('button', { name: 'Redirect' }).click();
    const ok = await poll(async () => /Redirected/.test(await p.locator('.police-log').innerText()), { timeout: 20000 });
    f.check('a gate redirect is carried out and logged', !!ok);
    return { gates };
  });
  await f.step('close-the-busiest-gate', async (p) => {
    await railTab(p, 'Gates');
    const rows = p.locator('.gates table tbody tr');
    const waits = await rows.evaluateAll((trs) => trs.map((tr) => Number((tr.children[4]?.textContent || '0').replace(/[^\d]/g, '')) || 0));
    const i = waits.indexOf(Math.max(...waits));
    const name = await rows.nth(i).locator('td').first().innerText();
    await rows.nth(i).getByRole('button', { name: 'Close' }).click();
    await sleep(9000);
    const table = await p.locator('.gates').innerText();
    return { closed: name, waitingBefore: waits[i], table };
  });
  await f.step('undo-last-order', async (p) => {
    await railTab(p, 'Orders');
    const undo = orders.getByRole('button', { name: /^Undo last order/ });
    const label = await undo.innerText();
    await undo.click();
    await sleep(2500);
    return { label, log: (await p.locator('.police-log').innerText()).split('\n').slice(0, 8) };
  });
  await f.step('order-log', async (p) => {
    await pause(p);
    await scrollRail(p, '.police-orders .police-log');
  }, { shot: true });
  await f.step('export-timeline-json', async (p) => {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }), orders.getByRole('button', { name: 'Export timeline (JSON)' }).click()]);
    const file = join(f.dir, 'timeline-export.json');
    await dl.saveAs(file);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    return { file, keys: Object.keys(json), entries: json.timeline?.length ?? null, first: json.timeline?.slice(0, 3) };
  });
  await f.step('print-after-action-report', async (p) => {
    await orders.getByRole('button', { name: 'Print after-action report' }).click();
    const html = await poll(() => p.evaluate(() => window.__gdPopup?.document?.body?.innerHTML ? window.__gdPopup.document.documentElement.outerHTML : null), { timeout: 8000 });
    if (html) writeFileSync(join(f.dir, 'after-action.html'), html);
    const text = await p.evaluate(() => window.__gdPopup?.document?.body?.innerText ?? '');
    await p.evaluate(() => window.__gdPopup?.close());
    f.check('the after-action report opens', text.length > 0);
    return { printCalls: await p.evaluate(() => window.__gdPrinted ?? 0), chars: text.length, excerpt: text.slice(0, 1200) };
  });
  await f.step('release-the-crowd-asks-to-confirm', async (p) => {
    await orders.getByRole('button', { name: /^Release the crowd/ }).click();
    const confirm = await orders.getByText('Everyone heads for the exits. Sure?').count();
    await orders.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => {});
    f.check('"Release the crowd" asks for confirmation', confirm > 0);
    return { confirm };
  });
}

async function flowOfficer(f) {
  await f.open({ path: OHIO, skipSignIn: false, viewport: PHONE, mobile: true, dsf: 2 });
  await f.step('demo-sign-in-as-officer', async (p) => {
    await p.locator('.demo-access').waitFor({ timeout: 30000 });
    await sleep(1600);
    await p.getByRole('button', { name: 'Officer', exact: true }).click();
    await sleep(400);
    return { dialog: await p.locator('.demo-access').innerText(), unitSelect: await p.locator('.demo-access select').count() };
  }, { shot: true });
  await f.step('choose-unit-and-enter', async (p) => {
    const sel = p.locator('.demo-access select');
    const t = Date.now();
    await sel.waitFor({ timeout: 150000 }); // units appear only once the map has loaded
    f.timing('unit-list-appears', Date.now() - t);
    const options = await sel.locator('option').allInnerTexts();
    await sel.selectOption({ index: Math.min(4, options.length - 1) });
    const unit = await sel.locator('option:checked').innerText();
    await p.getByRole('button', { name: 'Enter demo' }).click();
    await p.locator('.officer-console').waitFor({ timeout: 20000 });
    await waitReady(f, 150000);
    await f.layout('officer-phone');
    const fit = await p.evaluate(OVERFLOW_CULPRITS, PHONE.width);
    f.summary.metrics['phone-fit'] = fit;
    f.check('the officer screen fits a 390 px phone without zooming out', fit.innerWidth <= PHONE.width, `layout viewport ${fit.innerWidth} px, visual scale ${fit.visualScale}; ${fit.culprits.slice(0, 3).join('; ')}`);
    const transportVisible = await p.locator('.controls.transport').isVisible();
    const situationsVisible = await p.locator('nav.situations').isVisible();
    return { units: options.length, sample: options.slice(0, 6), unit, fit, simControlsShownToOfficer: { transportVisible, situationsVisible } };
  }, { shot: true });
  await f.step('run-acknowledge-and-ask-for-backup', async (p) => {
    await setSpeed(p, opts.speed);
    await play(p);
    await runUntil(f, -900, 150000, 'officer-run');
    await setSpeed(p, 5);
    const consoleEl = p.locator('.officer-console');
    const taps = [];
    taps.push(await tapControl(f, consoleEl.getByRole('button', { name: 'Acknowledge' }), 'Acknowledge'));
    await sleep(800);
    taps.push(await tapControl(f, consoleEl.getByRole('button', { name: 'Need backup' }), 'Need backup'));
    await sleep(1500);
    return { taps, console: await consoleEl.innerText() };
  }, { shot: true });
  await f.step('report-medical-on-map', async (p) => {
    const consoleEl = p.locator('.officer-console');
    await consoleEl.locator('select').selectOption('medical');
    const tap = await tapControl(f, consoleEl.getByRole('button', { name: 'Report incident on map' }), 'Report incident on map');
    await sleep(400);
    const hint = await p.locator('.police-pick').innerText().catch(() => '');
    const unitId = await p.evaluate(() => localStorage.getItem('gd-demo-unit'));
    const aim = await p.evaluate(AIM_3D, ['officer', { id: unitId, h: 0, scale: 9 }]);
    let placedBy = null;
    let touchEvents = null;
    let target = null;
    if (aim.ok) {
      await sleep(500);
      // Record what the canvas actually receives from the tap, and what the
      // ground under the aim point is (a building cell is ignored silently).
      target = await p.evaluate(([px, py]) => {
        const scene = window.gamedayScene;
        const canvas = document.querySelector('.crowd-host canvas');
        const r = canvas.getBoundingClientRect();
        const g = scene.groundAt(px - r.left, py - r.top);
        const map = scene.init.map;
        const u = Math.floor(g.mx / 2);
        const v = Math.floor(g.my / 2);
        window.__gdTouch = [];
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
          canvas.addEventListener(type, (e) => window.__gdTouch.push(`${type}:${e.pointerType ?? ''}@${Math.round(e.clientX)},${Math.round(e.clientY)}`), { once: true });
        }
        return { cell: v * map.width + u, ground: map.cells[v * map.width + u] ?? 'off-map' };
      }, [aim.px, aim.py]);
      // The pick needs a tap on the map itself; if the console sheet covers
      // that point, say so rather than tapping the sheet.
      if (aim.onCanvas) {
        await p.touchscreen.tap(aim.px, aim.py);
        placedBy = 'touch tap on the map';
        await sleep(1200);
        touchEvents = await p.evaluate(() => window.__gdTouch);
        if (await p.locator('.police-pick').count()) {
          // The tap did not land where it was aimed (see touchEvents). Drive
          // the same pointer sequence through the DOM at the aim point, so
          // the report path itself is still exercised.
          await p.evaluate(([px, py]) => {
            const canvas = document.querySelector('.crowd-host canvas');
            const o = { clientX: px, clientY: py, pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, button: 0 };
            try {
              canvas.dispatchEvent(new PointerEvent('pointerdown', o));
            } catch {
              // setPointerCapture rejects a synthetic pointer id; the press is still recorded
            }
            canvas.dispatchEvent(new PointerEvent('pointerup', o));
          }, [aim.px, aim.py]);
          placedBy = 'synthetic pointer events at the aim point (touch tap missed)';
        }
      } else placedBy = `not placed: ${aim.hit} covers the map at the aim point`;
    }
    await sleep(1500);
    const log = await p.locator('.officer-console').innerText().catch(() => '');
    const armed = await p.locator('.police-pick').count();
    f.check('the officer can report an incident at a spot on the map', armed === 0 && placedBy !== null && !/^not placed/.test(placedBy), `${placedBy}; pick still armed: ${armed}`);
    return { tap, hint, aim: { ok: aim.ok, hit: aim.hit, onCanvas: aim.onCanvas, why: aim.why, px: aim.px, py: aim.py }, target, touchEvents, placedBy, pickStillArmed: armed, console: log.slice(0, 600) };
  });
  await f.step('switch-to-supervisor-and-see-requests', async (p) => {
    await p.locator('.role-switch button').click();
    await p.locator('.demo-access').waitFor({ timeout: 10000 });
    await p.getByRole('button', { name: 'Supervisor', exact: true }).click();
    await p.getByRole('button', { name: 'Enter demo' }).click();
    await p.locator('.rail-tabs').waitFor({ timeout: 10000 });
    await railTab(p, 'Orders');
    const h = p.locator('.police-orders h3', { hasText: 'Officer requests' });
    await h.scrollIntoViewIfNeeded();
    const text = await h.innerText();
    f.check('the supervisor sees the officer requests', /\(([1-9]\d*)\)/.test(text), text);
    await f.layout('supervisor-phone');
    return { requests: text, list: await p.locator('.police-orders section').first().innerText() };
  }, { shot: true });
  await f.step('send-nearest-free-unit', async (p) => {
    const btn = p.locator('.police-orders').getByRole('button', { name: 'Send nearest free unit' }).first();
    const n = await btn.count();
    if (n && (await btn.isEnabled())) await btn.click();
    await sleep(2500);
    return { clicked: n > 0, log: (await p.locator('.police-log').innerText().catch(() => '')).split('\n').slice(0, 6) };
  });
}

async function flowKeyboard(f) {
  await openOhio(f);
  await f.step('tab-through-main-screen', async (p) => {
    await p.evaluate(() => document.activeElement?.blur?.());
    const total = await p.evaluate(FOCUSABLE_COUNT);
    const seq = [];
    const presses = Math.min(170, total + 15);
    for (let i = 0; i < presses; i++) {
      await p.keyboard.press('Tab');
      seq.push(await p.evaluate(FOCUS_INFO));
    }
    writeFileSync(join(f.dir, 'tab-sequence.json'), JSON.stringify(seq, null, 2));
    const key = (s) => `${s.tag}|${s.name}|${s.rect?.join(',')}`;
    const firstReal = seq.findIndex((s) => s.tag !== 'BODY');
    const wrappedAt = seq.findIndex((s, i) => i > firstReal && key(s) === key(seq[firstReal]));
    const real = seq.filter((s) => s.tag !== 'BODY');
    const noRing = real.filter((s) => !s.outline && !s.shadow);
    const offscreen = real.filter((s) => !s.inViewport);
    const obscured = real.filter((s) => s.obscured);
    const regions = real.reduce((m, s) => ({ ...m, [s.region]: (m[s.region] ?? 0) + 1 }), {});
    const runAt = seq.findIndex((s) => /Run all three plans/.test(s.name));
    f.check('every focused control shows a focus indicator', noRing.length === 0, `${noRing.length} of ${real.length} without outline or box-shadow`);
    f.check('focus wraps round the page (no keyboard trap)', wrappedAt > 0, `wrapped after ${wrappedAt} presses, ${total} focusable`);
    f.check('no focused control is hidden under another element', obscured.length === 0, obscured.slice(0, 4).map((s) => `${s.name}→${s.obscuredBy}`).join('; '));
    return {
      focusable: total,
      presses,
      wrappedAt,
      tabsToRunButton: runAt + 1,
      regions,
      withoutRing: noRing.slice(0, 12).map((s) => `${s.tag} "${s.name}" ${s.cls}`),
      offscreen: offscreen.slice(0, 12).map((s) => `${s.tag} "${s.name}" ${s.rect.join(',')}`),
      obscured: obscured.slice(0, 12).map((s) => `"${s.name}" under ${s.obscuredBy}`),
      first10: seq.slice(0, 10).map((s) => `${s.region}: ${s.tag} "${s.name}"`),
    };
  });
  await f.step('focus-ring-on-a-situation-button', async (p) => {
    await p.locator('nav.situations button').first().focus();
    await p.keyboard.press('Tab');
    return await p.evaluate(FOCUS_INFO);
  }, { shot: true });
  await f.step('start-run-from-keyboard', async (p) => {
    await p.locator('.speed button', { hasText: `${opts.speed}×` }).focus();
    await p.keyboard.press('Space');
    await p.locator('.controls.transport button.go.play').focus();
    await p.keyboard.press('Enter');
    const started = await poll(async () => (await readState(p))?.runs.some((r) => r.frames > 1), { timeout: 30000 });
    f.check('Enter on "Run all three plans" starts the run', !!started);
    await runUntil(f, -1500, 60000, 'keyboard-run');
    await p.keyboard.press('Enter'); // the same button now reads Pause
    return { transport: await transportText(p) };
  });
  await f.step('rail-tabs-with-arrow-keys', async (p) => {
    await p.locator('.rail-tabs [role=tab]').first().focus();
    await p.keyboard.press('ArrowRight');
    await sleep(300);
    const arrow = await p.evaluate(() => ({ focused: document.activeElement?.textContent, selected: document.querySelector('.rail-tabs [aria-selected=true]')?.textContent }));
    await p.keyboard.press('Tab');
    await p.keyboard.press('Enter');
    await sleep(400);
    const enter = await p.evaluate(() => ({ focused: document.activeElement?.textContent, selected: document.querySelector('.rail-tabs [aria-selected=true]')?.textContent }));
    const tabpanel = await p.locator('[role=tabpanel]').count();
    f.check('rail tabs follow the ARIA tabs pattern (arrow keys, tabpanel)', !/^Brief/.test(arrow.selected ?? 'Brief') && tabpanel > 0, `after ArrowRight selected=${arrow.selected}; tabpanels=${tabpanel}`);
    return { arrow, enter, tabpanel };
  }, { shot: true });
  await f.step('info-tip-on-focus', async (p) => {
    await railTab(p, 'Plans');
    const tip = p.locator('.rail-body .info').first();
    await tip.focus();
    const shown = await p.locator('.rail-body .info .info-pop').first().isVisible().catch(() => false);
    const role = await tip.getAttribute('role');
    return { shown, role, ariaDescribedBy: await tip.getAttribute('aria-describedby') };
  });
  await f.step('map-objects-from-keyboard', async (p) => {
    return p.evaluate(() => ({
      canvases: [...document.querySelectorAll('canvas')].map((c) => ({ tabIndex: c.tabIndex, label: c.getAttribute('aria-label'), role: c.getAttribute('role') })),
      mapButtons: [...document.querySelectorAll('.crowd-tools button, .view-toggle button')].map((b) => b.textContent),
      skipLink: !![...document.querySelectorAll('a[href^="#"]')].find((a) => /skip/i.test(a.textContent)),
      landmarks: [...document.querySelectorAll('header, main, nav, aside, [role=region], [role=main]')].map((e) => e.tagName.toLowerCase() + (e.getAttribute('aria-label') ? `[${e.getAttribute('aria-label')}]` : '')),
    }));
  });
}

const FLOWS = [
  { name: 'start', title: 'Start screen with no map; stadium search and import (Beaver Stadium)', run: flowStart, maxMin: 12 },
  { name: 'views', title: 'Ohio Stadium: 3D close-up, 2D plan, all three side by side; dark and light theme', run: flowViews, maxMin: 10 },
  { name: 'tabs', title: 'Every side-rail tab (Brief, Orders, Plans, Gates, Map key, About) on a live run', run: flowTabs, maxMin: 10 },
  { name: 'incident-surge', title: 'Gate surge at kickoff to completion: verdict, ranking, plan cards, replay, feedback, rewind', run: (f) => flowIncident(f, INCIDENTS.surge), maxMin: 12 },
  { name: 'incident-lightning', title: 'Lightning delay to completion: verdict, ranking, plan cards, replay', run: (f) => flowIncident(f, INCIDENTS.lightning), maxMin: 12 },
  { name: 'incident-package', title: 'Suspicious package at game end: verdict, ranking, plan cards, replay', run: (f) => flowIncident(f, INCIDENTS.package), maxMin: 15 },
  { name: 'incident-game-end', title: 'Game ends (egress) to completion: verdict, ranking, replay', run: (f) => flowIncident(f, INCIDENTS.gameEnd), maxMin: 10 },
  { name: 'plan-editor', title: 'Plan editor: edit a step, add a step, restart with changes, run it, reload', run: flowPlanEditor, maxMin: 10 },
  { name: 'inspectors', title: 'Click a fan, a vehicle and an officer on the 3D map', run: flowInspectors, maxMin: 8 },
  { name: 'police', title: 'Orders: dispatch a suggestion, barricade, marker, alert, redirect, gate, undo, exports', run: flowPolice, maxMin: 10 },
  { name: 'officer', title: 'Officer role via demo sign-in at 390x844: console, backup, report, supervisor hand-off', run: flowOfficer, viewport: PHONE, maxMin: 10 },
  { name: 'keyboard', title: 'Keyboard-only pass on the main screen: tab order, focus visibility, traps', run: flowKeyboard, maxMin: 8 },
];
const GROUPS = {
  all: FLOWS.map((f) => f.name),
  incidents: ['incident-surge', 'incident-lightning', 'incident-package', 'incident-game-end'],
  quick: ['start', 'views', 'tabs', 'keyboard'],
  interact: ['plan-editor', 'inspectors', 'police', 'officer'],
};

const INDEX_FILE = join(OUT, 'index.json');
function readIndex() {
  try {
    return JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return { flows: {} }; // first run
  }
}

/** Flows to run again, from what index.json says about earlier invocations. */
function fromIndex(which) {
  const flows = readIndex().flows ?? {};
  if (which === 'missing') return FLOWS.map((f) => f.name).filter((name) => !flows[name]);
  return FLOWS.map((f) => f.name).filter((name) => flows[name] && ['error', 'cut-off', 'running', 'skipped'].includes(flows[name].status));
}

function expand(names) {
  const out = [];
  for (const n of names) {
    const list = n === 'missing' || n === 'failed' ? fromIndex(n) : (GROUPS[n] ?? [n]);
    for (const name of list) {
      if (!FLOWS.some((f) => f.name === name)) fail(`unknown flow "${name}". Use --list.`);
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  if (opts.help || (!opts.list && requested.length === 0)) {
    console.log(HELP);
    return 0;
  }
  if (opts.list) {
    for (const f of FLOWS) console.log(`${f.name.padEnd(20)} ${f.title} (cap ${f.maxMin} min)`);
    for (const [g, list] of Object.entries(GROUPS)) console.log(`${('[' + g + ']').padEnd(20)} ${list.join(' ')}`);
    for (const g of ['missing', 'failed']) console.log(`${('[' + g + ']').padEnd(20)} ${fromIndex(g).join(' ') || '(none right now)'}`);
    return 0;
  }
  const selected = expand(requested);
  if (!selected.length) {
    log(`nothing to run: no flow matches ${requested.join(' ')}`);
    return 0;
  }
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  for (const name of selected) {
    rmSync(join(OUT, name), { recursive: true, force: true });
    for (const file of readdirSync(SHOTS)) if (file.startsWith(`audit-${name}-`)) rmSync(join(SHOTS, file), { force: true });
  }
  budget.used = countAuditShots();
  log(`flows: ${selected.join(', ')}; ${budget.used}/${budget.cap} audit screenshots already on disk; budget ${opts.maxMinutes} min`);

  const servers = opts.baseUrl ? { reused: opts.baseUrl, health: await fetchJson(`${BASE}/api/health`).catch((e) => ({ error: e.message })) } : await startServers();
  const { chromium, version } = await loadChromium();
  const t0 = Date.now();
  // Chromium's crash handler needs a writable HOME; in the sandbox /root is
  // read-only and the browser dies at launch (SIGTRAP) without this.
  const chromeHome = join(SERVER_DIR, 'chrome-home');
  mkdirSync(chromeHome, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.GD_CHROMIUM, headless: !opts.headed, args: CHROME_ARGS, env: { ...process.env, HOME: chromeHome } });
  log(`chromium ${browser.version()} up in ${Date.now() - t0} ms (playwright-core ${version})`);

  const results = [];
  // Merge into the index after every flow, so flows run in separate
  // invocations add up and a run cut off later still keeps what it finished.
  const saveIndex = () => {
    const index = readIndex();
    index.flows ??= {};
    index.updatedAt = new Date().toISOString();
    index.environment = { node: process.version, chromium: browser.version(), playwrightCore: version, chromeArgs: CHROME_ARGS, servers };
    index.screenshots = { cap: budget.cap, used: countAuditShots() };
    for (const r of results) index.flows[r.flow] = { ...r, at: r.at ?? index.updatedAt };
    writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  };
  for (const name of selected) {
    const def = FLOWS.find((f) => f.name === name);
    // Leave 45 s for closing the context, the browser and both children.
    const leftMs = RUN_DEADLINE - Date.now() - 45000;
    if (leftMs < 90000) {
      log(`== ${name}: skipped, only ${Math.max(0, Math.round(leftMs / 1000))} s of the --max-minutes budget left`);
      results.push({ flow: name, status: 'skipped', durationS: 0, steps: 0, stepErrors: [], failedChecks: [], consoleErrors: 0, pageErrors: 0, shots: 0, note: 'did not fit the --max-minutes budget' });
      saveIndex();
      continue;
    }
    const capMs = Math.min(def.maxMin * 60000, leftMs);
    const f = new FlowRun(def);
    log(`== ${name}: ${def.title} (cap ${Math.round(capMs / 1000)} s)`);
    try {
      await within(capMs, def.run(f), `flow ${name}`);
    } catch (e) {
      f.summary.status = capMs < def.maxMin * 60000 && /timed out/.test(e.message) ? 'cut-off' : 'error';
      f.summary.notes.push(`flow aborted: ${e.message}`);
      log(`  flow aborted: ${e.message}`);
    }
    // Closing the context also stops a flow that timed out but is still
    // awaiting the page: its pending calls reject and it unwinds.
    await f.close();
    const failed = f.summary.checks.filter((c) => !c.ok);
    results.push({
      flow: name,
      status: f.summary.status,
      durationS: Math.round(f.summary.durationMs / 1000),
      steps: f.summary.steps.length,
      stepErrors: f.summary.steps.filter((s) => s.status === 'error').map((s) => `${s.id}: ${s.error?.split('\n')[0]}`),
      failedChecks: failed.map((c) => c.name),
      consoleErrors: f.summary.console.errors,
      pageErrors: f.summary.pageErrors.length,
      shots: f.summary.shots.length,
      at: new Date().toISOString(),
    });
    saveIndex();
    log(`== ${name}: ${f.summary.status} in ${Math.round(f.summary.durationMs / 1000)} s, ${failed.length} failed checks, ${f.summary.shots.length} shots`);
  }
  saveIndex();

  console.log('\nflow                 status         time   checks failed  console errors  shots');
  for (const r of results) console.log(`${r.flow.padEnd(20)} ${r.status.padEnd(14)} ${String(r.durationS).padStart(4)} s  ${String(r.failedChecks.length).padStart(13)}  ${String(r.consoleErrors).padStart(14)}  ${String(r.shots).padStart(5)}`);
  console.log(`artifacts: ${OUT}\nscreenshots: ${SHOTS} (${countAuditShots()}/${budget.cap})`);
  const bad = results.some((r) => r.status === 'error' || (opts.strict && r.failedChecks.length));
  return bad ? 1 : 0;
}

main().then(
  (code) => shutdown(code),
  (e) => {
    console.error(e);
    void shutdown(2, e.message);
  },
);
