'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function validHome(home) {
  return typeof home === 'string' && path.isAbsolute(home) &&
    (fs.existsSync(path.join(home, 'sessions')) ||
      fs.existsSync(path.join(home, 'storages', 'session_projcache', 'sessions')));
}

function configuredHome() {
  const file = path.resolve(__dirname, '..', '..', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof config.dsh_home === 'string' ? config.dsh_home : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Invalid DSH plugin config: ${error.message}`);
  }
}

function resolveDshHome() {
  for (const home of [process.env.PRISM_DSH_HOME, configuredHome(), process.env.DSH_HOME]) {
    if (!home) continue;
    if (!validHome(home)) throw new Error(`DSH home is invalid: ${home}`);
    return path.resolve(home);
  }
  const homes = [path.join(os.homedir(), '.dsh')];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) homes.push(`${String.fromCharCode(code)}:\\.dsh`);
  }
  const found = homes.filter(validHome);
  if (!found.length) throw new Error('DSH home not found; set PRISM_DSH_HOME or DSH_HOME, or configure dsh_home');
  found.sort((a, b) => {
    const live = home => {
      try {
        const descriptor = JSON.parse(fs.readFileSync(path.join(home, 'prism-companion.json'), 'utf8'));
        return Number.isInteger(descriptor.port) && descriptor.port > 0 ? 1 : 0;
      } catch { return 0; }
    };
    return live(b) - live(a);
  });
  return found[0];
}

module.exports = { resolveDshHome };
