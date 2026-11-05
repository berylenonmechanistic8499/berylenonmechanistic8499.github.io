// Combines the collected dataset and the page's source into one self-contained page.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const moduleCode = (text) => text.replace(/^import .*\n/gm, '').replace(/^export /gm, '');

const FONTS = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap';
const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#10265f"/><path d="M5 16h22" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M11 8v7M11 19v5M21 6v3M21 13v13" stroke="#fff" stroke-opacity=".62" stroke-width="2.5" stroke-linecap="round"/></svg>')}`;

const SITE_URL = 'https://harshbhushandubey.github.io/pivot-calculator/';

const dataset = JSON.parse(await read('.cache/dataset.json'));
// "<" is escaped so that no headline or company name can end the script tag early.
const data = JSON.stringify(dataset).replace(/</g, '\\u003c');

const script = [
  moduleCode(await read('lib/pivot.js')),
  moduleCode(await read('lib/market.js')),
  moduleCode(await read('page/chart.js')),
  await read('page/app.js'),
].join('\n');

const head = [
  '<title>Pivot Calculator</title>',
  '<meta name="claude:viewport-fit-sides" content="cover">',
  `<link rel="preconnect" href="https://fonts.googleapis.com">`,
  `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
  `<link rel="stylesheet" href="${FONTS}">`,
  `<style>\n${await read('page/styles.css')}</style>`,
].join('\n');

const bodyFor = async (site) =>
  [
    await read('page/body.html'),
    `<script type="application/json" id="site-config">${JSON.stringify(site)}</script>`,
    `<script type="application/json" id="market-data">${data}</script>`,
    `<script type="module">\n${script}</script>`,
  ].join('\n');

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });

// The Claude artifact is a fixed copy that points to the live site. Its host supplies the document around it.
const archivedBody = await bodyFor({ autoUpdates: false, currentUrl: SITE_URL });
await writeFile(new URL('../dist/pivot-calculator.html', import.meta.url), `${head}\n${archivedBody}`);

// The live site, which also opens by itself from a double-click.
const body = await bodyFor({ autoUpdates: true });
await writeFile(
  new URL('../dist/index.html', import.meta.url),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="robots" content="noindex">\n<link rel="icon" href="${FAVICON}">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`,
);

console.log(`Built dist/index.html and dist/pivot-calculator.html: ${((head.length + body.length) / 1e6).toFixed(1)} MB, ${dataset.coverage}`);
