#!/usr/bin/env node
'use strict';
// Installs the Prism companion into DeepSeek Harness desktop (one time).
//   node scripts/install-companion.js            -> install / update
//   node scripts/install-companion.js --remove   -> uninstall
// What it does:
//   1. copies the companion to ~/.prism-dsh/companion (stable path, survives Hub updates)
//   2. writes the DSH data folder into ~/.prism-dsh/companion/dsh-home.txt
//   3. adds a "prism-companion" entry to <DSH_HOME>/profiles/desktop/cordis.patch.yml
//      (a backup .bak-<time> is written first; nothing is added twice)
// Then quit and reopen DeepSeek Harness. prism-companion.json appears in the DSH folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDshHomeInfo } = require('../dsh-home');

const FILES = ['index.js', 'package.json', 'cordis.patch.yml', 'desktop-patch.mjs'];
const MARK = 'prism-companion';

function findSource() {
  const cands = [path.join(__dirname, '..', 'companion'), path.join(__dirname, '..', '..', 'dsh-prism-companion')];
  for (const d of cands) if (fs.existsSync(path.join(d, 'index.js')) && fs.existsSync(path.join(d, 'package.json'))) return d;
  throw new Error('companion files not found next to the plugin (looked in ' + cands.join(', ') + ')');
}

function stripEntry(text) {
  // remove an existing "- insert:\n    - id: prism-companion\n      name: ...\n" block
  return text.replace(/^- insert:\r?\n\s+- id: prism-companion\r?\n\s+name: .*\r?\n?/m, '');
}

function main() {
  const remove = process.argv.includes('--remove');
  const info = resolveDshHomeInfo();
  const home = info.home;
  if (!home || !fs.existsSync(path.join(home, 'sessions'))) {
    console.error('DSH data folder not found (' + home + '). Run: node scripts/pick-dsh-home.js'); process.exit(1);
  }
  const profileDir = path.join(home, 'profiles', 'desktop');
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  let text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  if (text) {
    const bak = patchFile + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(patchFile, bak);
    console.log('backup  ' + bak);
  }
  text = stripEntry(text);
  if (/^\s*\[\s*\]\s*$/.test(text)) text = '';
  if (remove) {
    fs.writeFileSync(patchFile, text);
    console.log('removed prism-companion from ' + patchFile + '\nQuit and reopen DeepSeek Harness.');
    return;
  }
  const dest = path.join(os.homedir(), '.prism-dsh', 'companion');
  fs.mkdirSync(dest, { recursive: true });
  const src = findSource();
  for (const f of FILES) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  fs.writeFileSync(path.join(dest, 'dsh-home.txt'), home);
  const entry = path.join(dest, 'index.js').replace(/\\/g, '/');
  fs.mkdirSync(profileDir, { recursive: true });
  if (text && !text.endsWith('\n')) text += '\n';
  text += `- insert:\n    - id: ${MARK}\n      name: ${JSON.stringify(entry)}\n`;
  fs.writeFileSync(patchFile, text);
  console.log('DSH home ' + home + ' (from ' + info.source + ')');
  console.log('copied  ' + dest);
  console.log('patched ' + patchFile);
  console.log('\nNow quit DeepSeek Harness completely (tray icon too) and reopen it.');
  console.log('Check: ' + path.join(home, 'prism-companion.json') + ' should appear. Then run node scripts/diagnose.js');
}

try { main(); } catch (e) { console.error('install failed: ' + e.message); process.exit(1); }
