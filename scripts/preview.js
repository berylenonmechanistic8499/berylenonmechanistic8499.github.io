// Serves the built site on this computer. The page loads its data files, which browsers don't allow from a double-clicked file.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 4173;
const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };

createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const path = normalize(join(ROOT, relative));
  try {
    if (!path.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) throw new Error('Outside the site');
    const body = await readFile(path);
    response.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Preview at http://127.0.0.1:${PORT}`));
