'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDshAppPath, hostCli } = require('../dsh-app');

test('custom executable path is validated and used for ACP', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-dsh-app-'));
  const exe = path.join(dir, 'DeepSeek Harness.exe');
  fs.writeFileSync(exe, 'test fixture');
  const previous = process.env.PRISM_DSH_APP_PATH;
  try {
    process.env.PRISM_DSH_APP_PATH = exe;
    assert.equal(resolveDshAppPath(), exe);
    assert.equal(hostCli(exe), path.join(dir, 'resources', 'app.asar', 'dsh',
      'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'));
    process.env.PRISM_DSH_APP_PATH = path.join(dir, 'missing.exe');
    assert.throws(() => resolveDshAppPath(), /Invalid PRISM_DSH_APP_PATH/);
  } finally {
    if (previous === undefined) delete process.env.PRISM_DSH_APP_PATH;
    else process.env.PRISM_DSH_APP_PATH = previous;
    fs.rmSync(dir, { recursive:true, force:true });
  }
});
