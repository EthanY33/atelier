/**
 * Fixtures shared by the accessibility-design-audit tests: HTML pages and a
 * local HTTP server that can delay a stylesheet, hang a request, or answer
 * with an HTTP error.
 */
import { createServer } from 'node:http';

export const CLEAN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Clean Page</title>
</head>
<body>
  <main>
    <h1>Hello world</h1>
    <p>This is a clean accessible page.</p>
    <button type="button">Click me</button>
  </main>
</body>
</html>`;

/** One critical (image-alt) and one serious (html-has-lang) violation. */
export const BAD_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Bad Page</title>
</head>
<body>
  <main>
    <h1>Bad page</h1>
    <img src="photo.png">
  </main>
</body>
</html>`;

/** Selectors built from attribute values that try to break out of a code span. */
export const HOSTILE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Hostile</title></head>
<body>
  <main>
    <h1>Hostile</h1>
    <img src="a\`**ALL_CLEAR**\`.png">
    <img src="h\`<b>\`x.png">
  </main>
</body>
</html>`;

/** An image without alt inside an open shadow root and inside an iframe. */
export const NESTED_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Nested</title></head>
<body>
  <main>
    <h1>Nested</h1>
    <div id="host"></div>
    <iframe id="fr" title="inner" srcdoc="<!DOCTYPE html><html lang=en><head><title>inner</title></head><body><img id=x src=f.png></body></html>"></iframe>
  </main>
  <script>
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<img src="s.png">';
  </script>
</body>
</html>`;

/** Blocks the main thread forever shortly after the load event. */
export const BUSY_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Busy</title></head>
<body>
  <main><h1>Busy</h1></main>
  <script>window.addEventListener('load', () => setTimeout(() => { for (;;) {} }, 50));</script>
</body>
</html>`;

/** Adds an image without alt 1.5 s after load, after network idle has settled. */
export const LATE_CONTENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Late content</title></head>
<body>
  <main><h1>Late content</h1></main>
  <script>
    window.addEventListener('load', () => setTimeout(() => {
      const img = document.createElement('img');
      img.id = 'late';
      img.src = 'late.png';
      document.querySelector('main').append(img);
    }, 1500));
  </script>
</body>
</html>`;

const pageWithHead = (head) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Served</title>${head}</head>
<body><main><h1>Served page</h1><p>Some body text to check.</p></main></body>
</html>`;

/**
 * Start a server on 127.0.0.1 with these routes:
 *   /ok         clean page
 *   /late       clean page that links /late.css, served after `cssDelayMs`
 *   /late.css   low-contrast body colors
 *   /missing    accessible page with status 404
 *   /boom       accessible page with status 502
 *   /hang       page whose image request never answers (load never fires)
 * @param {{ cssDelayMs?: number }} [opts]
 * @returns {Promise<{ url: (path: string) => string, close: () => Promise<void> }>}
 */
export async function startServer({ cssDelayMs = 800 } = {}) {
  const hanging = new Set();
  const server = createServer((req, res) => {
    const html = (status, body) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    switch (req.url) {
      case '/ok':
        return html(200, CLEAN_HTML);
      case '/late':
        return html(200, pageWithHead('<link rel="stylesheet" href="/late.css">'));
      case '/late.css':
        return setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/css' });
          res.end('body { color: #999; background: #aaa; }');
        }, cssDelayMs);
      case '/missing':
        return html(404, CLEAN_HTML.replace('Clean Page', 'Not found'));
      case '/boom':
        return html(502, CLEAN_HTML.replace('Clean Page', 'Bad gateway'));
      case '/hang':
        return html(200, pageWithHead('').replace('</main>', '<img alt="" src="/never.png"></main>'));
      case '/never.png':
        hanging.add(res);
        return undefined;
      default:
        return html(404, 'not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
