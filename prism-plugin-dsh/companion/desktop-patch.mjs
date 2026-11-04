import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function desktopPatch(entry = fileURLToPath(new URL('./index.js', import.meta.url))) {
  const name = path.resolve(entry).replaceAll('\\', '/');
  return `- insert:\n    - id: prism-companion\n      name: ${JSON.stringify(name)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(desktopPatch());
}
