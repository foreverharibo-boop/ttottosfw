import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const index = new URL('index.js', root);
let source = fs.readFileSync(index, 'utf8');
for (const file of ['scene-field-size.js', 'scene-collection-sfw-ui.js', 'slow-burn-turns.js', 'scene-body.js', 'body-tokens.js', 'compact-report.js']) {
    const start = `// BEGIN ${file}\n`, end = `\n// END ${file}`;
    const a = source.indexOf(start), b = source.indexOf(end, a);
    if (a < 0 || b < 0) throw new Error(`Missing embedded block: ${file}`);
    const helper = fs.readFileSync(new URL(file, root), 'utf8').replaceAll('export function ', 'function ');
    source = source.slice(0, a + start.length) + helper + source.slice(b);
}
fs.writeFileSync(index, source);
