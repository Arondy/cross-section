const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = new URL('./public/', import.meta.url);
const LOG_DIR = new URL('./tmp/', import.meta.url);

/** Keeps stray log files inside tmp/ so one folder wipe cleans the project. */
async function writeLog(name: string, message: string): Promise<void> {
  try {
    await Bun.write(new URL(name, LOG_DIR), `${new Date().toISOString()} ${message}\n`, {
      append: true,
    } as never);
  } catch {
    // logging must never take the server down
  }
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function safePath(url: string): string {
  const clean = decodeURIComponent(url.split('?')[0]);
  const normalized = clean.replace(/\\/g, '/').replace(/\/+/g, '/');
  const noTravel = normalized.split('/').filter((s) => s && s !== '..' && s !== '.');
  return noTravel.join('/');
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, runtime: `bun ${Bun.version}` });
    }

    let path = safePath(url.pathname);
    if (path === '' || path === 'index.html') path = 'index.html';

    const candidates = [path, `dist/${path}`];
    for (const rel of candidates) {
      const file = Bun.file(new URL(rel, PUBLIC_DIR));
      if (await file.exists()) {
        const ext = rel.slice(rel.lastIndexOf('.'));
        return new Response(file, {
          headers: {
            'content-type': MIME[ext] ?? 'application/octet-stream',
            'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
          },
        });
      }
    }

    void writeLog('server-404.log', `404 ${new URL(req.url).pathname}`);
    return new Response('Not found', { status: 404 });
  },
  error(err) {
    void writeLog('server-errors.log', `${err.message}`);
    return new Response('Internal error', { status: 500 });
  },
});

void writeLog('server.log', `Сервер запущен: http://localhost:${server.port}`);
console.log(`Сервер запущен: http://localhost:${server.port}`);
