import { mkdir, cp, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
await access(new URL('site/data/bootstrap.json', root));
JSON.parse(await readFile(new URL('site/data/bootstrap.json', root), 'utf8'));
await mkdir(new URL('dist/', root), { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.js', 'favicon.svg', '.nojekyll', 'lib', 'data']) {
  await cp(new URL(`site/${name}`, root), new URL(`dist/${name}`, root), { recursive: true });
}
console.log(`Static build ready: ${fileURLToPath(new URL('dist/', root))}`);
