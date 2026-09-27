// Copies data/role_based.txt and data/consumer_domains.txt into the inline JSON block
// in public/index.html (the browser engine reads it). Run after editing either list:
//   node website/scripts/sync-lists.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const read = f => [...new Set(
    readFileSync(new URL(`data/${f}`, root), 'utf8').split('\n').map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#'))
)];

const page = fileURLToPath(new URL('website/public/index.html', root));
const html = readFileSync(page, 'utf8');
const json = JSON.stringify({ role: read('role_based.txt'), consumer: read('consumer_domains.txt') });
const block = /(<script type="application\/json" id="lists">)[\s\S]*?(<\/script>)/;
if (!block.test(html)) throw new Error('lists block not found in index.html');
writeFileSync(page, html.replace(block, `$1${json}$2`));
console.log('synced lists into', page);
