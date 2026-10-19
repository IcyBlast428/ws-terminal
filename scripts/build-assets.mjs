import { build } from 'esbuild';
import { readFile, readdir, writeFile, cp, mkdir } from 'node:fs/promises';
const inputs = [];
for (const name of ['editor', 'auth', 'previews']) {
  const result = await build({ entryPoints: [`public/source/${name}.js`], bundle: true, minify: true, format: 'iife', target: ['es2022'], outfile: `public/assets/${name}.bundle.js`, metafile: true, external: ['/assets/*'] });
  inputs.push(...Object.keys(result.metafile.inputs));
}
const pdf = 'node_modules/pdfjs-dist';
await mkdir('public/assets/pdf', { recursive: true });
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) await cp(`${pdf}/build/${file}`, `public/assets/pdf/${file}`);
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await cp(`${pdf}/${directory}`, `public/assets/pdf/${directory}`, { recursive: true });
await cp(`${pdf}/LICENSE`, 'public/assets/pdf/LICENSE');
const packages = new Set(inputs.filter(input => input.startsWith('node_modules/')).map(input => {
  const parts = input.slice('node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}));
packages.add('pdfjs-dist');
const notices = [];
for (const name of [...packages].sort()) {
  const root = `node_modules/${name}`;
  const metadata = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  const license = (await readdir(root)).find(file => /^licen[sc]e(?:\.md|\.txt)?$/i.test(file));
  if (!license) throw new Error(`License file missing for bundled package ${name}`);
  notices.push(`${name} ${metadata.version}\n${'-'.repeat(60)}\n${await readFile(`${root}/${license}`, 'utf8')}`);
}
await writeFile('public/assets/THIRD-PARTY-NOTICES.txt', notices.join('\n\n'));
