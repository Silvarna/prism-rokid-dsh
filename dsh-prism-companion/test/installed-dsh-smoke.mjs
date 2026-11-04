import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { desktopPatch } from '../desktop-patch.mjs';

const app = process.env.PRISM_DSH_APP_PATH;
if (!app || !fs.existsSync(app)) throw new Error('Set PRISM_DSH_APP_PATH to the installed DeepSeek Harness executable');
const cli = path.join(path.dirname(app), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-dsh-companion-smoke-'));
const overlay = path.join(home, 'desktop.patch.yml');
fs.writeFileSync(overlay, desktopPatch());
const descriptor = path.join(home, 'prism-companion.json');
const child = spawn(app, ['--expose-internals', cli, '--profile', 'acp', '--patch', overlay], {
  env:{ ...process.env, ELECTRON_RUN_AS_NODE:'1', DSH_HOME:home },
  windowsHide:true, stdio:['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
try {
  let info;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(descriptor)) { info = JSON.parse(fs.readFileSync(descriptor, 'utf8')); break; }
    if (child.exitCode !== null) throw new Error(`DSH exited before companion loaded: ${stderr.slice(-1000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(info, `DSH companion failed to start: ${stderr.slice(-1000)}`);
  const response = await fetch(`http://127.0.0.1:${info.port}/health`, { headers:{ authorization:`Bearer ${info.token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  process.stdout.write('Installed DSH ACP profile loaded companion and answered authenticated health check.\n');
} finally {
  child.kill();
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  fs.rmSync(home, { recursive:true, force:true });
}
