import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

import { ensureViolentmonkey } from '../../tools/fetch-violentmonkey.mjs';

const SHADOW_DECLARATION = "const SHADOW_MODE = 'closed';";

/**
 * @typedef {import('@playwright/test').BrowserContext} BrowserContext
 * @typedef {import('node:http').IncomingMessage} Request
 * @typedef {import('node:http').ServerResponse} Response
 */

/**
 * @param {string} path
 * @returns {string}
 */
function contentType(path) {
  if (path.endsWith('.js')) {
    return 'text/javascript; charset=utf-8';
  }
  if (path.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  return 'text/html; charset=utf-8';
}

/**
 * Serves fixed routes on 127.0.0.1 on a free port.
 * @param {Record<string, string | ((req: Request, res: Response) => void)>} routes
 * @returns {Promise<{ origin: string, port: number, close: () => Promise<void> }>}
 */
export async function serve(routes) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (typeof route === 'function') {
      route(req, res);
    } else if (typeof route === 'string') {
      res.writeHead(200, { 'content-type': contentType(path) });
      res.end(route);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server has no TCP address');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
        server.closeAllConnections();
      }),
  };
}

/**
 * Switches a script's closed shadow root to open so tests can reach into it.
 * @param {string} source
 * @returns {string}
 */
export function openShadow(source) {
  const count = source.split(SHADOW_DECLARATION).length - 1;
  if (count !== 1) {
    throw new Error(`expected exactly one ${SHADOW_DECLARATION} but found ${count}`);
  }
  return source.replace(SHADOW_DECLARATION, "const SHADOW_MODE = 'open';");
}

/**
 * @param {BrowserContext} context
 * @returns {Promise<import('@playwright/test').Worker>}
 */
async function serviceWorkerOf(context) {
  const [worker] = context.serviceWorkers();
  return worker ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
}

/**
 * Manifest V3 extensions can only register user scripts once this per-extension
 * toggle is on, and nothing reports the failure when it is off.
 * @param {BrowserContext} context
 * @param {string} extensionId
 */
async function allowUserScripts(context, extensionId) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome://extensions/?id=${extensionId}`);
    const toggle = page.locator('extensions-toggle-row#allow-user-scripts cr-toggle');
    try {
      await toggle.waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(
        'Allow user scripts toggle not found on chrome://extensions; scripts would not run',
        { cause: error },
      );
    }
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  } finally {
    await page.close();
  }
}

/**
 * @param {import('@playwright/test').Worker} worker
 */
async function waitForInjector(worker) {
  await expect(async () => {
    const ids = await worker.evaluate(async () =>
      (await chrome.userScripts.getScripts()).map((script) => script.id),
    );
    expect(ids).toContain('1001');
  }, 'Violentmonkey never registered its injector').toPass({ timeout: 15_000 });
}

/**
 * Opens Violentmonkey's popup bound to the given page's tab. The target stays the active
 * tab and the popup opens in the background, which is what makes the popup list that
 * tab's menu commands.
 * @param {BrowserContext} context
 * @param {string} extensionId
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<import('@playwright/test').Page>}
 */
export async function openMenu(context, extensionId, page) {
  await page.bringToFront();
  const worker = await serviceWorkerOf(context);
  const opened = context.waitForEvent('page', { timeout: 15_000 });
  await worker.evaluate(
    (url) => chrome.tabs.create({ url, active: false }),
    `chrome-extension://${extensionId}/popup/index.html`,
  );
  const popup = await opened;
  await popup.waitForLoadState();
  return popup;
}

/**
 * Launches Chromium with the pinned Violentmonkey in a fresh temporary profile.
 * `CHROMIUM_PATH` selects a system Chromium instead of Playwright's.
 * @param {{ hostMap?: Record<string, number> }} [options] Maps host names to local ports.
 * @returns {Promise<{
 *   context: BrowserContext,
 *   extensionId: string,
 *   install: (source: string) => Promise<void>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function launchWithViolentmonkey(options = {}) {
  const extensionDir = await ensureViolentmonkey();
  const profile = await mkdtemp(join(tmpdir(), 'userscripts-e2e-'));
  const args = [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`];
  const rules = Object.entries(options.hostMap ?? {}).map(
    ([host, port]) => `MAP ${host} 127.0.0.1:${port}`,
  );
  if (rules.length > 0) {
    args.push(`--host-resolver-rules=${rules.join(',')}`);
  }
  const executablePath = process.env.CHROMIUM_PATH;
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      headless: true,
      args,
    });

  /** @type {BrowserContext | undefined} */
  let context;
  try {
    // Violentmonkey only registers its injector at startup, so the toggle is set in a
    // throwaway first launch and the real one starts with the API already available.
    const setup = await launch();
    try {
      const worker = await serviceWorkerOf(setup);
      await allowUserScripts(setup, new URL(worker.url()).host);
    } finally {
      await setup.close();
    }
    const running = await launch();
    context = running;
    const worker = await serviceWorkerOf(running);
    const extensionId = new URL(worker.url()).host;
    await waitForInjector(worker);
    return {
      context: running,
      extensionId,
      async install(source) {
        const site = await serve({ '/x.user.js': source });
        const page = await running.newPage();
        try {
          await page.goto(`${site.origin}/x.user.js`).catch(() => {});
          await page.waitForURL((url) => url.host === extensionId, { timeout: 20_000 });
          await page.locator('#confirm').click({ timeout: 20_000 });
          await page.getByText('Script installed.').waitFor({ timeout: 20_000 });
          // Pages opened right after the install can miss the new script.
          await page.waitForTimeout(2000);
        } finally {
          await page.close().catch(() => {});
          await site.close();
        }
      },
      async close() {
        await running.close();
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
