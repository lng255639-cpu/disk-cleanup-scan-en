#!/usr/bin/env node
// disk_scan.mjs — read-only scan of disk usage, long-unused large files and cleanable items.
// This script only reads file metadata (size, timestamps). It never deletes or modifies anything.
//
// Usage:
//   node disk_scan.mjs [--path DIR] [--days 365] [--min-size 50] [--top 20]
//                      [--depth 3] [--dupes] [--exclude str,str] [--json]
//   --path      Folder or drive root to scan, repeatable; defaults to the home folder
//   --days      Days without use that count as "long unused", default 365
//   --min-size  Threshold for the large-file lists (MB), default 50
//   --top       Rows per table, default 20
//   --depth     How many folder levels to aggregate, default 3
//   --dupes     Also find large files with identical content (reads files to hash, slower)
//   --exclude   Skip paths containing any of these strings (case-insensitive, comma-separated)
//   --json      Print JSON instead of Markdown

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

// ---------- Arguments ----------
const argv = process.argv.slice(2);
const opt = { paths: [], days: 365, minSize: 50, top: 20, depth: 3, dupes: false, exclude: [], json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--path') opt.paths.push(next());
  else if (a === '--days') opt.days = Number(next());
  else if (a === '--min-size') opt.minSize = Number(next());
  else if (a === '--top') opt.top = Number(next());
  else if (a === '--depth') opt.depth = Number(next());
  else if (a === '--dupes') opt.dupes = true;
  else if (a === '--exclude') opt.exclude.push(...next().split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  else if (a === '--json') opt.json = true;
  else if (a === '-h' || a === '--help') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).join('\n').replace(/^\/\/ ?/gm, ''));
    process.exit(0);
  } else { console.error(`Unknown argument: ${a}`); process.exit(2); }
}
if (!opt.paths.length) opt.paths.push(os.homedir());

const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();
const NOW = Date.now();
const DAY = 86400000;
const STALE_MS = opt.days * DAY;
const MIN_BYTES = opt.minSize * 1024 * 1024;

// ---------- Helpers ----------
const norm = p => p.replace(/\\/g, '/').toLowerCase();
const human = n => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
};
const date = ms => new Date(ms).toISOString().slice(0, 10);
const age = ms => {
  const d = Math.floor((NOW - ms) / DAY);
  return d >= 730 ? `${(d / 365).toFixed(1)} years` : `${d} days`;
};
const show = p => {
  const h = HOME + path.sep;
  return p.startsWith(h) ? '~' + path.sep + p.slice(h.length) : p;
};
const mdCell = s => String(s).replace(/\|/g, '\\|');

// ---------- Not scanned (system areas, virtual file systems) ----------
const SKIP_WIN = [/^[a-z]:\/windows$/, /^[a-z]:\/system volume information$/, /^[a-z]:\/\$winreagent$/,
  /^[a-z]:\/recovery$/, /^[a-z]:\/config\.msi$/, /^[a-z]:\/\$windows\.~(bt|ws)$/];
const SKIP_POSIX = [/^\/proc$/, /^\/sys$/, /^\/dev$/, /^\/run$/, /^\/system$/, /^\/private\/var\/vm$/,
  /^\/volumes$/, /^\/snap$/, /^\/mnt\/wsl/];
const SKIP_FILES = /^[a-z]:\/(pagefile|hiberfil|swapfile|dumpstack\.log)/;
const isSkipped = np => (IS_WIN ? SKIP_WIN : SKIP_POSIX).some(r => r.test(np)) || opt.exclude.some(x => np.includes(x));

// ---------- Cleanable categories (matched by path) ----------
// risk: cache = cache/temp, the app rebuilds it; rebuild = dev artifacts, restored by reinstall/rebuild;
//       review = the user has to look and decide
const CATEGORIES = [
  { id: 'recycle', label: 'Recycle Bin', risk: 'cache', re: /^([a-z]:\/\$recycle\.bin)\// },
  { id: 'temp', label: 'Temp folders', risk: 'cache', re: /^(.*\/appdata\/local\/temp)\// },
  { id: 'temp', label: 'Temp folders', risk: 'cache', re: /^(\/tmp|\/var\/tmp|\/private\/var\/folders)\// },
  { id: 'browser', label: 'Browser caches', risk: 'cache', re: /^(.*\/user data\/[^/]+\/(cache|code cache|gpucache|service worker\/cachestorage))\// },
  { id: 'browser', label: 'Browser caches', risk: 'cache', re: /^(.*\/mozilla\/firefox\/profiles\/[^/]+\/cache2)\// },
  { id: 'browser', label: 'Browser caches', risk: 'cache', re: /^(.*\/library\/caches\/(google|com\.apple\.safari|firefox)[^/]*)\// },
  { id: 'pkgcache', label: 'Package manager caches', risk: 'cache',
    re: /^(.*\/(npm-cache|\.npm\/_cacache|pip\/cache|\.cache\/pip|yarn\/cache|\.yarn\/berry\/cache|pnpm\/store|\.pnpm-store|uv\/cache|\.cache\/uv|\.nuget\/packages|\.gradle\/caches|\.m2\/repository|go\/pkg\/mod|\.cargo\/registry|composer\/cache|bun\/install\/cache))\// },
  { id: 'crash', label: 'Crash dumps', risk: 'cache', re: /^(.*\/(crashdumps|crashpad|minidump))\// },
  { id: 'crash', label: 'Crash dumps', risk: 'cache', re: /^(.+\.(dmp|mdmp))$/ },
  { id: 'devbuild', label: 'node_modules (restored by npm install)', risk: 'rebuild', re: /^(.*?\/node_modules)\// },
  { id: 'devbuild', label: 'Python virtualenvs / caches', risk: 'rebuild', re: /^(.*?\/(\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.tox))\// },
  { id: 'devbuild', label: 'Build output', risk: 'rebuild', re: /^(.*?\/(\.next|\.nuxt|\.parcel-cache|\.turbo|\.angular\/cache))\// },
  { id: 'devbuild', label: 'Game engine import cache', risk: 'rebuild', re: /^(.*?\/\.godot\/imported)\// },
  { id: 'installer', label: 'Installers / archives in Downloads', risk: 'review', re: /^(.*\/downloads\/.*\.(exe|msi|msix|iso|img|dmg|pkg|zip|7z|rar|tar|gz|tgz|xz|apk))$/ },
  { id: 'log', label: 'Log files (.log)', risk: 'review', re: /^(.+\.log(\.\d+)?)$/ },
  { id: 'backup', label: 'Backup / temp extensions', risk: 'review', re: /^(.+\.(bak|old|tmp|temp|~tmp|crdownload|part|partial))$/ },
];
// Rules ending in $ match a single file; the others match a whole folder
for (const c of CATEGORIES) c.file = c.re.source.endsWith('$');
// node_modules bundled with installed apps, global npm packages, etc. break the app if deleted, so they are not "rebuildable"
const APP_INTERNAL = /\/(program files[^/]*|appdata|library\/application support|[^/]+\.app\/contents|resources\/app(\.asar\.unpacked)?|site-packages|lib\/python[^/]*|\.local\/share|lib\/node_modules)\//;
// Categorizing runs for every file, so files in the same folder share the result
const catCache = new Map();
function categorize(np) {
  const dir = np.slice(0, np.lastIndexOf('/'));
  let dirHit = catCache.get(dir);
  if (dirHit === undefined) {
    dirHit = null;
    const appInternal = APP_INTERNAL.test(dir + '/');
    for (const c of CATEGORIES) {
      if (c.file || (appInternal && c.risk === 'rebuild')) continue;
      const m = (dir + '/x').match(c.re);
      if (m) { dirHit = { c, root: m[1] }; break; }
    }
    if (catCache.size > 200000) catCache.clear();
    catCache.set(dir, dirHit);
  }
  if (dirHit) return dirHit;
  for (const c of CATEGORIES) {
    if (!c.file) continue;
    const m = np.match(c.re);
    if (m) return { c, root: m[1] };
  }
  return null;
}

// A short "can I touch this" label for a path
function advice(np) {
  if (/^[a-z]:\/(windows|programdata)(\/|$)/.test(np) || /\/appdata\/(local|roaming)\/microsoft(\/|$)/.test(np)
    || /^\/(system|usr|bin|sbin|lib|etc|library|private)(\/|$)/.test(np)) return 'System, do not delete by hand';
  if (/^[a-z]:\/program files( \(x86\))?\/[^/]+/.test(np) || /\/appdata\/local\/programs\/[^/]+/.test(np)
    || /^\/applications\/[^/]+\.app/.test(np)) return 'App, use uninstall';
  if (/\/\.git(\/|$)/.test(np)) return 'git repo, keep';
  const hit = categorize(np + '/x');
  if (hit) return hit.c.risk === 'cache' ? 'Cache, safe to clear' : hit.c.risk === 'rebuild' ? 'Rebuildable' : 'Your call';
  if (/\/onedrive[^/]*(\/|$)/.test(np)) return 'Cloud-synced, your call';
  if (/\/(documents|desktop|pictures|videos|music|downloads|movies)(\/|$)/.test(np)) return 'Personal files, your call';
  if (/\/appdata(\/|$)/.test(np) || /\/library\/(application support|containers)(\/|$)/.test(np) || /\/\.(local\/share|config)(\/|$)/.test(np))
    return 'App data, clean from inside the app';
  return '';
}

// ---------- Disk overview ----------
function diskOverview() {
  const roots = IS_WIN
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `${l}:\\`).filter(r => { try { return fs.existsSync(r); } catch { return false; } })
    : ['/', ...(process.platform === 'darwin' ? [] : [HOME])];
  const out = [];
  const seen = new Set();
  for (const r of roots) {
    try {
      const s = fs.statfsSync(r);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      const key = `${total}:${free}`;
      if (!total || seen.has(key)) continue;
      seen.add(key);
      out.push({ root: r, total, used: total - free, free, pct: Math.round((total - free) / total * 100) });
    } catch { /* optical drives, disconnected network drives */ }
  }
  return out;
}

// Windows can have last-access-time updates turned off; then only the modified time is meaningful
function atimeStatus() {
  if (!IS_WIN) return { reliable: true, note: '' };
  try {
    const t = execSync('fsutil behavior query disablelastaccess', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const v = Number((t.match(/=\s*(\d)/) || [])[1]);
    if (v === 1 || v === 3) return { reliable: false, note: 'Windows has last-access-time updates turned off, so "last used" can only use the modified time; files that were opened but never changed may look long unused.' };
    return { reliable: true, note: '' };
  } catch { return { reliable: true, note: '' }; }
}

// ---------- Scan ----------
const st = {
  files: 0, dirs: 0, bytes: 0, logical: 0, errors: 0, links: 0, skipped: [],
  sparse: 0,            // files whose logical size is much larger than their on-disk size (sparse, compressed, cloud placeholder)
  folders: new Map(),   // folder path -> { size, files, newest }
  big: [],              // files >= MIN_BYTES
  ext: new Map(),       // extension -> { size, count }
  cats: new Map(),      // category id -> { label, risk, size, count, roots: Map }
  ageBuckets: [[30, 0], [180, 0], [365, 0], [730, 0], [1825, 0], [Infinity, 0]],
  staleBytes: 0, staleFiles: 0,
  sizeGroups: opt.dupes ? new Map() : null,
};

// Every size is the on-disk size (stat.blocks × 512, which on Windows is Explorer's "Size on disk").
// Sparse files (e.g. emulator virtual disks), NTFS-compressed files and OneDrive cloud-only files
// can have a logical size far above what they occupy; fall back to the logical size only when blocks is missing.
const allocated = s => (Number.isFinite(s.blocks) ? s.blocks * 512 : s.size);
const isSparse = (logical, size) => logical - size > 1024 * 1024 && size < logical * 0.8;

function addFile(full, s, rootLen, rootParts) {
  const logical = s.size;
  const size = allocated(s);
  const last = Math.max(s.mtimeMs, s.atimeMs || 0);
  const np = norm(full);
  st.files++; st.bytes += size; st.logical += logical;
  if (isSparse(logical, size)) st.sparse++;

  // Folder totals (down to --depth levels)
  const rel = full.slice(rootLen).split(/[\\/]/).filter(Boolean);
  let cur = rootParts;
  for (let d = 0; d < Math.min(rel.length - 1, opt.depth); d++) {
    cur = cur + (cur.endsWith(path.sep) ? '' : path.sep) + rel[d];
    let f = st.folders.get(cur);
    if (!f) st.folders.set(cur, f = { size: 0, files: 0, newest: 0 });
    f.size += size; f.files++; if (last > f.newest) f.newest = last;
  }

  const ext = (path.extname(full).toLowerCase() || '(none)').slice(0, 12);
  const e = st.ext.get(ext) || { size: 0, count: 0 };
  e.size += size; e.count++; st.ext.set(ext, e);

  const ageDays = (NOW - last) / DAY;
  for (const b of st.ageBuckets) if (ageDays < b[0]) { b[1] += size; break; }
  if (NOW - last >= STALE_MS) { st.staleBytes += size; st.staleFiles++; }

  const hit = categorize(np);
  if (hit) {
    let c = st.cats.get(hit.c.id + hit.c.label);
    if (!c) st.cats.set(hit.c.id + hit.c.label, c = { label: hit.c.label, risk: hit.c.risk, size: 0, count: 0, roots: new Map() });
    c.size += size; c.count++;
    // Keep the root's original casing by slicing the same length from full
    const root = full.slice(0, hit.root.length);
    const r = c.roots.get(root) || { size: 0, newest: 0 };
    r.size += size; if (last > r.newest) r.newest = last;
    c.roots.set(root, r);
  }

  if (size >= MIN_BYTES) st.big.push({ path: full, size, logical, last, mtime: s.mtimeMs });
  // Duplicates compare content, so group by logical size
  if (st.sizeGroups && size >= MIN_BYTES) {
    const g = st.sizeGroups.get(logical) || [];
    g.push({ path: full, size }); st.sizeGroups.set(logical, g);
  }
}

async function scanRoot(root) {
  root = path.resolve(root);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`${root} is not a folder`);
  const rootDev = rootStat.dev;
  const queue = [root];
  let active = 0;
  const CONC = 48;
  let lastTick = Date.now();

  async function handleDir(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { st.errors++; return; }
    st.dirs++;
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const np = norm(full);
      if (ent.isDirectory()) {
        if (isSkipped(np)) { st.skipped.push(full); continue; }
        queue.push(full);
        continue;
      }
      if (IS_WIN && SKIP_FILES.test(np)) continue;
      try {
        const s = await fsp.lstat(full);
        if (s.isSymbolicLink()) { st.links++; continue; }   // do not follow symlinks / junctions, to avoid double counting
        if (s.isDirectory()) {
          if (s.dev !== rootDev || isSkipped(np)) { st.skipped.push(full); continue; }
          queue.push(full);
        } else if (s.isFile()) addFile(full, s, root.length, root);
      } catch { st.errors++; }
    }
    if (!opt.json && Date.now() - lastTick > 5000) {
      lastTick = Date.now();
      process.stderr.write(`  ...scanned ${st.files.toLocaleString()} files, ${human(st.bytes)}\n`);
    }
  }

  await new Promise((resolve) => {
    const pump = () => {
      while (active < CONC && queue.length) {
        active++;
        handleDir(queue.pop()).finally(() => { active--; pump(); });
      }
      if (!active && !queue.length) resolve();
    };
    pump();
  });
}

// ---------- Duplicate files (optional) ----------
async function hashFile(p, partial) {
  const h = crypto.createHash('sha1');
  if (partial) {
    const fh = await fsp.open(p, 'r');
    try {
      const { size } = await fh.stat();
      const CH = 1 << 20, buf = Buffer.alloc(CH);
      for (const pos of [0, Math.max(0, Math.floor(size / 2) - CH / 2), Math.max(0, size - CH)]) {
        const { bytesRead } = await fh.read(buf, 0, CH, pos);
        h.update(buf.subarray(0, bytesRead));
      }
    } finally { await fh.close(); }
  } else {
    await new Promise((res, rej) => fs.createReadStream(p).on('data', d => h.update(d)).on('end', res).on('error', rej));
  }
  return h.digest('hex');
}
// Group files by hash, keep groups of two or more
async function bucket(files, partial) {
  const by = new Map();
  for (const f of files) {
    try {
      const k = await hashFile(f.path, partial);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(f);
    } catch { st.errors++; }
  }
  return [...by.values()].filter(v => v.length > 1);
}
// Same size -> compare first/middle/last 1 MB -> compare whole file; saving = keep the largest copy, count the rest's on-disk size
async function findDupes() {
  const groups = [];
  for (const [size, list] of st.sizeGroups) {
    if (list.length < 2) continue;
    for (const cand of await bucket(list, true))
      for (const files of await bucket(cand, false)) {
        const used = files.map(f => f.size);
        groups.push({ size, saving: used.reduce((a, b) => a + b, 0) - Math.max(...used), files: files.map(f => f.path) });
      }
  }
  return groups.sort((a, b) => b.saving - a.saving);
}

// ---------- Main ----------
const t0 = Date.now();
const disks = diskOverview();
const atime = atimeStatus();
for (const p of opt.paths) {
  if (!opt.json) process.stderr.write(`Scanning ${p} ...\n`);
  try { await scanRoot(p); } catch (e) { console.error(`Cannot scan ${p}: ${e.message}`); }
}
const dupes = opt.dupes ? await findDupes() : [];
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const folders = [...st.folders.entries()].map(([p, f]) => ({ path: p, ...f }));
const topFolders = depth => folders
  .filter(f => opt.paths.some(r => {
    const rel = path.relative(path.resolve(r), f.path);
    return rel && !rel.startsWith('..') && rel.split(/[\\/]/).length === depth;
  }))
  .sort((a, b) => b.size - a.size).slice(0, opt.top);

// Long-unused folders: even the newest file inside is past the threshold; keep only the outermost
const staleFoldersAll = folders.filter(f => NOW - f.newest >= STALE_MS && f.size >= MIN_BYTES).sort((a, b) => a.path.length - b.path.length);
const staleFolders = [];
for (const f of staleFoldersAll) if (!staleFolders.some(o => f.path.startsWith(o.path + path.sep))) staleFolders.push(f);
staleFolders.sort((a, b) => b.size - a.size);

const big = st.big.sort((a, b) => b.size - a.size);
const staleBig = big.filter(f => NOW - f.last >= STALE_MS);
const cats = [...st.cats.values()].sort((a, b) => b.size - a.size);

const result = {
  scanned: opt.paths.map(p => path.resolve(p)), seconds: Number(secs), days: opt.days, minSizeMB: opt.minSize,
  disks, atimeReliable: atime.reliable,
  totals: { files: st.files, dirs: st.dirs, bytes: st.bytes, logicalBytes: st.logical, sparseFiles: st.sparse, errors: st.errors, links: st.links, skipped: st.skipped, staleFiles: st.staleFiles, staleBytes: st.staleBytes },
  ageBuckets: st.ageBuckets.map(([d, b]) => ({ underDays: d === Infinity ? null : d, bytes: b })),
  topFolders1: topFolders(1), topFolders2: topFolders(2), topFolders3: topFolders(3),
  biggestFiles: big.slice(0, opt.top),
  staleBigFiles: staleBig.slice(0, opt.top * 2),
  staleFolders: staleFolders.slice(0, opt.top),
  categories: cats.map(c => ({ label: c.label, risk: c.risk, size: c.size, count: c.count,
    roots: [...c.roots.entries()].map(([p, r]) => ({ path: p, ...r })).sort((a, b) => b.size - a.size).slice(0, 8) })),
  extensions: [...st.ext.entries()].map(([ext, e]) => ({ ext, ...e })).sort((a, b) => b.size - a.size).slice(0, 15),
  duplicates: dupes.slice(0, opt.top),
};

if (opt.json) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }

// ---------- Markdown output ----------
const L = [];
const table = (head, rows) => {
  if (!rows.length) { L.push('(none)', ''); return; }
  L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
  for (const r of rows) L.push(`| ${r.map(mdCell).join(' | ')} |`);
  L.push('');
};
// On-disk size; when it differs a lot from the labeled size, show both so Explorer's "Size" does not mislead
const fileSize = f => isSparse(f.logical, f.size) ? `${human(f.size)} (labeled ${human(f.logical)}, sparse/compressed)` : human(f.size);

L.push('# Disk Usage Scan Report', '');
L.push(`Scanned: ${result.scanned.map(show).join(', ')}  |  Took ${secs} s  |  "Long unused" = not modified or opened for more than ${opt.days} days`, '');
if (atime.note) L.push(`> Note: ${atime.note}`, '');

L.push('## Disk overview', '');
table(['Drive', 'Total', 'Used', 'Free', 'Used %'], disks.map(d => [d.root, human(d.total), human(d.used), human(d.free), `${d.pct}%${d.pct >= 90 ? ' ⚠' : ''}`]));

L.push('## Scan summary', '');
table(['Item', 'Value'], [
  ['Files', st.files.toLocaleString()],
  ['On disk', human(st.bytes)],
  ...(st.logical - st.bytes > 1024 ** 3 ? [['Labeled size total', `${human(st.logical)} (${st.sparse.toLocaleString()} sparse/compressed/cloud-placeholder files do not really take that much)`]] : []),
  [`Files unused for over ${opt.days} days`, `${st.staleFiles.toLocaleString()} files, ${human(st.staleBytes)} (${st.bytes ? Math.round(st.staleBytes / st.bytes * 100) : 0}%)`],
  ['Unreadable (permissions etc.)', `${st.errors.toLocaleString()} items`],
  ['Skipped system areas / links', `${st.skipped.length} folders, ${st.links} links`],
]);

L.push('## By last use', '');
const labels = ['Within 30 days', '1-6 months', '6-12 months', '1-2 years', '2-5 years', 'Over 5 years'];
table(['Last used', 'Size', 'Share'], st.ageBuckets.map(([, b], i) => [labels[i], human(b), `${st.bytes ? Math.round(b / st.bytes * 100) : 0}%`]));

L.push('## Largest folders (level 1)', '');
table(['Folder', 'On disk', 'Files', 'Last used', 'Advice'], result.topFolders1.map(f => [show(f.path), human(f.size), f.files.toLocaleString(), date(f.newest), advice(norm(f.path))]));
L.push('## Largest folders (level 2)', '');
table(['Folder', 'On disk', 'Files', 'Last used', 'Advice'], result.topFolders2.map(f => [show(f.path), human(f.size), f.files.toLocaleString(), date(f.newest), advice(norm(f.path))]));
if (opt.depth >= 3) {
  L.push('## Largest folders (level 3)', '');
  table(['Folder', 'On disk', 'Files', 'Last used', 'Advice'], result.topFolders3.map(f => [show(f.path), human(f.size), f.files.toLocaleString(), date(f.newest), advice(norm(f.path))]));
}

L.push(`## Whole folders long unused (>= ${opt.minSize} MB, even the newest file is over ${opt.days} days old)`, '');
table(['Folder', 'On disk', 'Files', 'Newest file', 'Unused for', 'Advice'], result.staleFolders.map(f => [show(f.path), human(f.size), f.files.toLocaleString(), date(f.newest), age(f.newest), advice(norm(f.path))]));

L.push(`## Long-unused large files (>= ${opt.minSize} MB, over ${opt.days} days)`, '');
table(['File', 'On disk', 'Last used', 'Unused for', 'Advice'], result.staleBigFiles.map(f => [show(f.path), fileSize(f), date(f.last), age(f.last), advice(norm(f.path))]));

L.push('## Largest files', '');
table(['File', 'On disk', 'Last used', 'Advice'], result.biggestFiles.map(f => [show(f.path), fileSize(f), date(f.last), advice(norm(f.path))]));

L.push('## Cleanable categories', '');
const riskLabel = { cache: 'Cache, safe to clear', rebuild: 'Rebuildable', review: 'Your call' };
table(['Category', 'Size', 'Files', 'Kind', 'Biggest locations'], result.categories.filter(c => c.size >= 1024 * 1024).map(c => [c.label, human(c.size), c.count.toLocaleString(), riskLabel[c.risk],
  c.roots.slice(0, 3).map(r => `${show(r.path)} (${human(r.size)})`).join('<br>')]));

L.push('## Extensions using the most space', '');
table(['Extension', 'Size', 'Files'], result.extensions.map(e => [e.ext, human(e.size), e.count.toLocaleString()]));

if (opt.dupes) {
  L.push(`## Large files with identical content (>= ${opt.minSize} MB)`, '');
  table(['File size', 'Copies', 'Can save', 'Locations'], result.duplicates.map(g => [human(g.size), g.files.length, human(g.saving), g.files.map(show).join('<br>')]));
}

L.push('---', 'This report only read file metadata. Nothing was deleted or modified.');
console.log(L.join('\n'));
