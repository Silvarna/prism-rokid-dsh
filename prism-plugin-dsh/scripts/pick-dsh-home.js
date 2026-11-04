#!/usr/bin/env node
'use strict';
// Choose the DSH data folder (the one with sessions/ inside, usually .dsh).
//   node scripts/pick-dsh-home.js            -> opens a folder picker
//   node scripts/pick-dsh-home.js D:\DSH-data -> uses this path
//   node scripts/pick-dsh-home.js --show     -> prints what the plugin will use
// Saves dsh_home into the plugin's config.json (~/.prism/pluginbridge-plugins/dsh/config.json)
// and ~/.prism-dsh/config.json. Restart Prism Hub (or toggle the plugin) afterwards.
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolveDshHomeInfo, saveDshHome, CONFIG_FILES } = require('../dsh-home');

function pickFolder() {
  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "Choose the DeepSeek Harness data folder (.dsh, contains sessions)"',
      `$d.SelectedPath = "${path.join(os.homedir(), '.dsh')}"`,
      '$d.ShowNewFolderButton = $false',
      'if ($d.ShowDialog() -eq "OK") { [Console]::Out.Write($d.SelectedPath) }',
    ].join('; ');
    return execFileSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding:'utf8', windowsHide:false }).trim();
  }
  if (process.platform === 'darwin') {
    const script = 'POSIX path of (choose folder with prompt "Choose the DeepSeek Harness data folder (.dsh, contains sessions)" default location (path to home folder) with invisibles)';
    return execFileSync('osascript', ['-e', script], { encoding:'utf8' }).trim();
  }
  try { return execFileSync('zenity', ['--file-selection', '--directory'], { encoding:'utf8' }).trim(); }
  catch { throw new Error('No folder picker here; pass the path as an argument'); }
}

function main() {
  const arg = process.argv[2];
  if (arg === '--show') {
    const info = resolveDshHomeInfo();
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  const chosen = arg || pickFolder();
  if (!chosen) { console.log('Cancelled.'); return; }
  const files = CONFIG_FILES();
  const first = saveDshHome(chosen, files[0]);
  saveDshHome(chosen, files[1]);
  console.log(`DSH home: ${first.home}`);
  console.log(`Saved to: ${files.join('  and  ')}`);
  console.log('Restart Prism Hub (or turn the DSH plugin off and on) to apply.');
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
