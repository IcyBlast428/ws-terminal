import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['public/source/editor.js'], bundle: true, minify: true, format: 'iife', target: ['es2020'], outfile: 'public/assets/editor.bundle.js', metafile: true });
const packages = new Set(Object.keys(result.metafile.inputs).filter(input => input.startsWith('node_modules/')).map(input => {
  const parts = input.slice('node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}));
const notices = [];
for (const name of [...packages].sort()) {
  const root = `node_modules/${name}`;
  const metadata = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  const license = (await readdir(root)).find(file => /^licen[sc]e(?:\.md|\.txt)?$/i.test(file));
  if (!license) throw new Error(`License file missing for bundled package ${name}`);
  notices.push(`${name} ${metadata.version}\n${'-'.repeat(60)}\n${await readFile(`${root}/${license}`, 'utf8')}`);
}
await writeFile('public/assets/THIRD-PARTY-NOTICES.txt', notices.join('\n\n'));
