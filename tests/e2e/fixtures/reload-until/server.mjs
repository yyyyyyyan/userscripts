import { serve } from '../../harness.mjs';

/**
 * @typedef {import('node:http').ServerResponse} Response
 */

const TARGET = '<p id="target">In stock</p>';

/** How long `/slow` takes to answer every request after the first. */
const SLOW_RELOAD_MS = 1500;

/**
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function page(title, body) {
  return `<!doctype html><html lang="en"><title>${title}</title><h1>${title}</h1>${body}</html>`;
}

/**
 * @param {Response} res
 * @param {string} body
 * @param {Record<string, string>} [headers]
 */
function html(res, body, headers = {}) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * @param {Response} res
 * @param {string} location
 */
function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

/**
 * Starts the Reload Until fixture site. Request counts are kept per path and query,
 * so `/appear?a` and `/appear?b` behave as separate pages.
 * @returns {Promise<{
 *   origin: string,
 *   port: number,
 *   count: (pathAndQuery: string) => number,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startFixtures() {
  /** @type {Map<string, number>} */
  const counts = new Map();
  let port = 0;

  /**
   * @param {(res: Response, nth: number) => void} handler
   * @returns {(req: import('node:http').IncomingMessage, res: Response) => void}
   */
  function counted(handler) {
    return (req, res) => {
      const key = req.url ?? '/';
      const nth = (counts.get(key) ?? 0) + 1;
      counts.set(key, nth);
      handler(res, nth);
    };
  }

  const site = await serve({
    '/appear': counted((res, nth) => html(res, page('Appear', nth >= 2 ? TARGET : ''))),
    '/disappear': counted((res, nth) => html(res, page('Disappear', nth === 1 ? TARGET : ''))),
    '/redirect': counted((res, nth) =>
      nth >= 2 ? redirect(res, '/login') : html(res, page('Redirect', '')),
    ),
    '/xredirect': counted((res, nth) =>
      nth >= 2
        ? redirect(res, `http://other.test:${port}/login`)
        : html(res, page('Cross-site redirect', '')),
    ),
    '/slow': counted((res, nth) =>
      setTimeout(() => html(res, page('Slow', '')), nth >= 2 ? SLOW_RELOAD_MS : 0),
    ),
    '/login': counted((res) => html(res, page('Sign in', '<form><input name="user"></form>'))),
    '/hidden': counted((res, nth) =>
      html(
        res,
        page(
          'Hidden',
          nth === 1
            ? '<p class="status">Sold out</p>'
            : '<p class="status" hidden>Sold out</p><script>const label = "Sold out";</script>',
        ),
      ),
    ),
    '/plain': counted((res) => html(res, page('Plain', '<p>Nothing to watch here.</p>'))),
    '/csp': counted((res) =>
      html(res, page('Strict CSP', ''), { 'content-security-policy': "style-src 'self'" }),
    ),
  });
  port = site.port;

  return {
    ...site,
    count: (pathAndQuery) => counts.get(pathAndQuery) ?? 0,
  };
}
