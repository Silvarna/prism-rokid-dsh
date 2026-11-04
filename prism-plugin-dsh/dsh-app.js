'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolveDshHome } = require('./dsh-home');

function hostCli(exe) {
  return path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules',
    '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
}

function resolveDshAppPath() {
  const configured = process.env.PRISM_DSH_APP_PATH;
  if (configured) {
    if (!path.isAbsolute(configured) || !fs.existsSync(configured)) {
      throw new Error(`Invalid PRISM_DSH_APP_PATH: ${configured}`);
    }
    return configured;
  }
  const roots = [];
  if (process.platform === 'win32') {
    try {
      const drive = path.parse(resolveDshHome()).root;
      roots.push(path.join(drive, 'Program Files'), path.join(drive, 'Program Files (x86)'));
    } catch {}
  }
  roots.push(process.env.ProgramFiles, process.env.ProgramW6432,
    process.env['ProgramFiles(x86)']);
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      roots.push(path.join(drive, 'Program Files'), path.join(drive, 'Program Files (x86)'));
    }
  }
  const checked = new Set();
  for (const root of roots) {
    if (!root) continue;
    const exe = path.join(root, 'DeepSeek Harness', 'DeepSeek Harness.exe');
    const key = exe.toLowerCase();
    if (checked.has(key)) continue;
    checked.add(key);
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('DeepSeek Harness desktop app not found; set PRISM_DSH_APP_PATH');
}

module.exports = { resolveDshAppPath, hostCli };
