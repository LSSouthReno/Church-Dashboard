// Serves a built beta folder the way GitHub Pages does (index.html for folders,
// 404.html for unknown paths, so clean URLs like /church work). Used by `stage.sh --local`.
//   node scripts/beta-serve.mjs <folder> [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8790);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.ico': 'image/x-icon' };

function send(res, file, status = 200) {
  res.writeHead(status, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    if (fs.statSync(file).isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }); return res.end(); }
      file = path.join(file, 'index.html');
    }
    if (fs.existsSync(file)) return send(res, file);
  } catch {}
  send(res, path.join(root, '404.html'), 404);
}).listen(port, () => console.log(`beta → http://localhost:${port}/  (serving ${root})`));
