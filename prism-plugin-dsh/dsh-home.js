'use strict';
// Where is the DSH data directory?  Order (first hit wins):
//   1. PRISM_DSH_HOME env
//   2. dsh_home in a config.json (plugin root's parent, then ~/.prism-dsh/config.json)
//   3. DSH_HOME env of this process
//   4. DSH_HOME saved for the user but not visible to this process
//      (Windows: HKCU\Environment, set after Prism Hub started; macOS: launchctl getenv)
//   5. ~/.dsh, and on Windows X:\.dsh on every drive
// A chosen folder may be the DSH home itself or its parent (we also try <folder>/.dsh).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const CONFIG_FILES = () => [
  path.resolve(__dirname, '..', '..', 'config.json'),
  path.join(os.homedir(), '.prism-dsh', 'config.json'),
];

function looksLikeHome(home) {
  return typeof home === 'string' && path.isAbsolute(home) &&
    (fs.existsSync(path.join(home, 'sessions')) ||
      fs.existsSync(path.join(home, 'storages', 'session_projcache', 'sessions')) ||
      fs.existsSync(path.join(home, 'prism-companion.json')));
}

// Accept the folder itself or its .dsh child.
function normalizeHome(home) {
  if (typeof home !== 'string' || !home.trim()) return undefined;
  let value = home.trim().replace(/^"(.*)"$/, '$1');
  if (value.startsWith('~')) value = path.join(os.homedir(), value.slice(1));
  value = path.resolve(value);
  if (looksLikeHome(value)) return value;
  const child = path.join(value, '.dsh');
  if (looksLikeHome(child)) return child;
  return undefined;
}

function configuredHome() {
  for (const file of CONFIG_FILES()) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof config.dsh_home === 'string' && config.dsh_home.trim()) return { value:config.dsh_home, source:file };
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Invalid DSH plugin config ${file}: ${error.message}`);
    }
  }
  return undefined;
}

function savedUserEnv() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'DSH_HOME'], { encoding:'utf8', windowsHide:true, timeout:3000, stdio:['ignore', 'pipe', 'ignore'] });
      const m = /DSH_HOME\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(out);
      if (m) return m[1].trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
    } else if (process.platform === 'darwin') {
      const out = execFileSync('launchctl', ['getenv', 'DSH_HOME'], { encoding:'utf8', timeout:3000, stdio:['ignore', 'pipe', 'ignore'] }).trim();
      if (out) return out;
    }
  } catch {}
  return undefined;
}

function hasLiveCompanion(home) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, 'prism-companion.json'), 'utf8'));
    return Number.isInteger(d.port) && d.port > 0;
  } catch { return false; }
}

// Returns { home, source, tried:[{source,value,ok}] }; never throws.
function resolveDshHomeInfo() {
  const tried = [];
  const explicit = [];
  if (process.env.PRISM_DSH_HOME) explicit.push({ source:'PRISM_DSH_HOME', value:process.env.PRISM_DSH_HOME });
  const cfg = configuredHome();
  if (cfg) explicit.push({ source:`config ${cfg.source}`, value:cfg.value });
  if (process.env.DSH_HOME) explicit.push({ source:'DSH_HOME', value:process.env.DSH_HOME });
  const saved = savedUserEnv();
  if (saved && saved !== process.env.DSH_HOME) explicit.push({ source:'DSH_HOME (saved user env)', value:saved });
  for (const c of explicit) {
    const home = normalizeHome(c.value);
    tried.push({ ...c, ok:!!home });
    if (home) return { home, source:c.source, tried };
  }
  const defaults = [path.join(os.homedir(), '.dsh')];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) defaults.push(`${String.fromCharCode(code)}:\\.dsh`);
  }
  const found = defaults.filter(looksLikeHome);
  for (const d of defaults.slice(0, 1)) tried.push({ source:'default', value:d, ok:found.includes(d) });
  if (found.length) {
    found.sort((a, b) => Number(hasLiveCompanion(b)) - Number(hasLiveCompanion(a)));
    return { home:found[0], source:'default', tried };
  }
  return { home:undefined, source:'', tried };
}

function resolveDshHome() {
  const info = resolveDshHomeInfo();
  if (info.home) return info.home;
  const detail = info.tried.map(t => `${t.source}=${t.value}${t.ok ? '' : ' (no sessions/ inside)'}`).join('; ');
  throw new Error(`DSH home not found. Run "node scripts/pick-dsh-home.js" in the plugin folder, or set DSH_HOME. Tried: ${detail || 'nothing'}`);
}

function saveDshHome(home, file = CONFIG_FILES()[0]) {
  const resolved = normalizeHome(home);
  if (!resolved) throw new Error(`Not a DSH data folder (no sessions/ inside): ${home}`);
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  config.dsh_home = resolved;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return { home:resolved, file };
}

module.exports = { resolveDshHome, resolveDshHomeInfo, normalizeHome, saveDshHome, CONFIG_FILES };
