import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

import { launchWithViolentmonkey, openMenu, serve } from './harness.mjs';

/**
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {import('@playwright/test').BrowserContext} BrowserContext
 * @typedef {import('node:http').IncomingMessage} Request
 * @typedef {import('node:http').ServerResponse} Response
 * @typedef {'light' | 'dark'} Scheme
 * @typedef {Awaited<ReturnType<typeof launchWithViolentmonkey>>} Manager
 * @typedef {{ host?: string, path?: string, spy?: boolean }} OpenOptions
 */

const script = await readFile(
  new URL(
    '../../scripts/per-site-light-dark-mode/per-site-light-dark-mode.user.js',
    import.meta.url,
  ),
  'utf8',
);

const WHITE = 'rgb(255, 255, 255)';
const BLACK = 'rgb(0, 0, 0)';
const PLAIN_PAGE = '<!doctype html><title>plain</title><p>hello</p>';
const RELOADS = '(reloads the tab)';

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
const fixture = (name) =>
  readFile(new URL(`./fixtures/site-color/${name}`, import.meta.url), 'utf8');

/**
 * @param {Page} page
 * @returns {Promise<string>}
 */
const backgroundOf = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/**
 * @param {Page} page
 * @returns {Promise<boolean>}
 */
const prefersDark = (page) =>
  page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);

/**
 * Picks a menu entry through the manager's popup and waits for the reload it triggers.
 * @param {BrowserContext} context
 * @param {string} extensionId
 * @param {Page} page
 * @param {string} label Text the entry contains, such as `Dark for`.
 */
async function choose(context, extensionId, page, label) {
  const popup = await openMenu(context, extensionId, page);
  const reloaded = page.waitForEvent('load');
  await popup.getByText(label).click();
  await reloaded;
  await popup.close();
}

/**
 * @param {Manager} vm
 * @param {Page} page
 * @returns {Promise<string[]>} The script's menu entries for the page's tab, in order.
 */
async function menuEntries(vm, page) {
  const popup = await openMenu(vm.context, vm.extensionId, page);
  const entries = popup.locator('.submenu-commands .menu-item');
  await entries.first().waitFor();
  const labels = await entries.allInnerTexts();
  await popup.close();
  return labels.map((label) => label.trim());
}

/**
 * Chooses **Status** and returns the text of the dialog it shows.
 * @param {Manager} vm
 * @param {Page} page
 * @returns {Promise<string>}
 */
async function readStatus(vm, page) {
  const dialog = page.waitForEvent('dialog');
  const popup = await openMenu(vm.context, vm.extensionId, page);
  await popup.getByText('Status', { exact: true }).click();
  const shown = await dialog;
  await shown.accept();
  await popup.close();
  return shown.message();
}

/**
 * Counts assignments to `document.adoptedStyleSheets`, which is how a pin re-check shows up
 * from outside: each one lifts the pin and puts it back.
 */
function countAdoptedAssignments() {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
  if (!original?.set) return;
  const set = original.set;
  Object.defineProperty(window, '__adoptedAssignments', { value: { count: 0 } });
  Object.defineProperty(Document.prototype, 'adoptedStyleSheets', {
    ...original,
    set(value) {
      window['__adoptedAssignments'].count++;
      set.call(this, value);
    },
  });
}

/**
 * Serves `routes`, maps every name in `hosts` to that server, and installs the script.
 * @param {{
 *   routes: Record<string, string | ((req: Request, res: Response) => void)>,
 *   hosts?: string[],
 * }} setup
 * @param {(ctx: {
 *   vm: Manager,
 *   open: (scheme: Scheme, options?: OpenOptions) => Promise<Page>,
 * }) => Promise<void>} body
 */
async function withSites({ routes, hosts = [] }, body) {
  const site = await serve(routes);
  const vm = await launchWithViolentmonkey({
    hostMap: Object.fromEntries(hosts.map((host) => [host, site.port])),
  });
  try {
    await vm.install(script);
    await body({
      vm,
      async open(scheme, { host = '127.0.0.1', path = '/', spy = false } = {}) {
        const page = await vm.context.newPage();
        if (spy) await page.addInitScript(countAdoptedAssignments);
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`http://${host}:${site.port}${path}`);
        return page;
      },
    });
  } finally {
    await vm.close();
    await site.close();
  }
}

/**
 * @param {string} html
 * @param {Parameters<typeof withSites>[1]} body
 */
const withSite = (html, body) => withSites({ routes: { '/': html } }, body);

/**
 * Checks the browser in light and in dark, each against a real no-choice baseline and then
 * against the opposite saved choice.
 * @param {string} html
 * @param {(page: Page) => Promise<unknown>} read
 * @param {{ light: unknown, dark: unknown }} expected What `read` returns for each scheme.
 */
async function followsSavedChoice(html, read, expected) {
  await withSite(html, async ({ vm, open }) => {
    const { context, extensionId } = vm;

    const lightBrowser = await open('light');
    await expect.poll(() => read(lightBrowser)).toEqual(expected.light);
    await choose(context, extensionId, lightBrowser, 'Dark for');
    await expect.poll(() => read(lightBrowser)).toEqual(expected.dark);
    await lightBrowser.close();

    const darkBrowser = await open('dark');
    await choose(context, extensionId, darkBrowser, 'Browser default for');
    await expect.poll(() => read(darkBrowser)).toEqual(expected.dark);
    await choose(context, extensionId, darkBrowser, 'Light for');
    await expect.poll(() => read(darkBrowser)).toEqual(expected.light);
  });
}

test('a page that checks matchMedia after load follows the saved choice in both directions', async () => {
  await followsSavedChoice(PLAIN_PAGE, prefersDark, { light: false, dark: true });
});

test('CSS media rules follow the saved choice in both directions', async () => {
  await followsSavedChoice(await fixture('media-rule.html'), backgroundOf, {
    light: WHITE,
    dark: BLACK,
  });
});

test('a site that declares automatic through inline style follows the saved choice', async () => {
  await followsSavedChoice(await fixture('ld-js.html'), backgroundOf, {
    light: WHITE,
    dark: BLACK,
  });
});

/**
 * @param {string} name
 * @param {string} button The page's own switch to light.
 */
async function siteSwitchWins(name, button) {
  await withSite(await fixture(name), async ({ vm, open }) => {
    const page = await open('light');
    expect(await backgroundOf(page)).toBe(WHITE);
    await choose(vm.context, vm.extensionId, page, 'Dark for');
    await expect.poll(() => backgroundOf(page)).toBe(BLACK);
    await page.locator(button).click();
    await expect.poll(() => backgroundOf(page)).toBe(WHITE);
    const status = await readStatus(vm, page);
    expect(status).toContain('The site has set its own light color scheme');
    expect(status).not.toContain('removed');
  });
}

test("the site's own switch wins once used", async () => {
  await siteSwitchWins('ld-toggle.html', '#light');
});

test("a bare data-theme attribute selector is the site's own switch", async () => {
  await siteSwitchWins('bare-toggle.html', '#attribute');
});

test("a bare class selector is the site's own switch", async () => {
  await siteSwitchWins('bare-toggle.html', '#class');
});

test('the pin comes back after the page drops it, and status tells the truth', async () => {
  await withSite(await fixture('ld-toggle.html'), async ({ vm, open }) => {
    const page = await open('light');
    await choose(vm.context, vm.extensionId, page, 'Dark for');
    await expect.poll(() => backgroundOf(page)).toBe(BLACK);

    const DROPPED = 'The page later removed the color scheme the script set';
    expect(await readStatus(vm, page)).not.toContain(DROPPED);

    await page.evaluate(() => {
      document.adoptedStyleSheets = [];
    });
    await expect.poll(() => backgroundOf(page)).toBe(WHITE);
    const dropped = await readStatus(vm, page);
    expect(dropped).toContain(DROPPED);
    expect(dropped).toContain("this page may show your browser's setting until you reload it");
    expect(dropped).not.toContain('The site has set its own');

    await page.evaluate(() => {
      document.documentElement.dataset.touched = 'yes';
    });
    await expect.poll(() => backgroundOf(page)).toBe(BLACK);
    expect(await readStatus(vm, page)).not.toContain(DROPPED);
  });
});

/**
 * Opens the dark-saved page with the assignment counter installed and lets the pin settle.
 * @param {Parameters<Parameters<typeof withSite>[1]>[0]} ctx
 * @returns {Promise<Page>}
 */
async function settledDarkPage({ vm, open }) {
  const setup = await open('light');
  await choose(vm.context, vm.extensionId, setup, 'Dark for');
  await setup.close();
  const page = await open('light', { spy: true });
  await expect.poll(() => backgroundOf(page)).toBe(BLACK);
  await page.waitForTimeout(500);
  return page;
}

test('writing a css variable to html every frame causes no re-checks', async () => {
  await withSite(await fixture('ld-toggle.html'), async (ctx) => {
    const page = await settledDarkPage(ctx);
    const assignments = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const counter = window['__adoptedAssignments'];
          const before = counter.count;
          let n = 0;
          const tick = () => {
            document.documentElement.style.setProperty('--scroll', String(n));
            if (++n < 90) requestAnimationFrame(tick);
            else requestAnimationFrame(() => resolve(counter.count - before));
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(assignments).toBeLessThanOrEqual(2);
    expect(await backgroundOf(page)).toBe(BLACK);
  });
});

test('class toggles on html are re-checked at most once per frame', async () => {
  await withSite(await fixture('ld-toggle.html'), async (ctx) => {
    const page = await settledDarkPage(ctx);
    const { assignments, frames, toggles } = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const counter = window['__adoptedAssignments'];
          const before = counter.count;
          let frames = 0;
          let toggles = 0;
          let running = true;
          const frame = () => {
            frames++;
            if (running) requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
          const toggle = () => {
            document.documentElement.classList.toggle('busy');
            if (++toggles < 200) setTimeout(toggle, 0);
            else {
              running = false;
              requestAnimationFrame(() =>
                resolve({ assignments: counter.count - before, frames, toggles }),
              );
            }
          };
          toggle();
        }),
    );
    expect(toggles).toBeGreaterThan(frames);
    expect(assignments).toBeGreaterThan(0);
    expect(assignments).toBeLessThanOrEqual(2 * (frames + 1));
    expect(await backgroundOf(page)).toBe(BLACK);
  });
});

const SITES = ['example.test', 'docs.example.test', 'other.test'];

test('a choice on a site covers its subdomains', async () => {
  await withSites(
    { routes: { '/': await fixture('media-rule.html') }, hosts: SITES },
    async ({ vm, open }) => {
      const parent = await open('light', { host: 'example.test' });
      await choose(vm.context, vm.extensionId, parent, 'Dark for');
      await expect.poll(() => backgroundOf(parent)).toBe(BLACK);

      const docs = await open('light', { host: 'docs.example.test' });
      await expect.poll(() => backgroundOf(docs)).toBe(BLACK);
      expect(await menuEntries(vm, docs)).toContain(
        `✓ Dark for docs.example.test (from example.test, reloads the tab)`,
      );

      const other = await open('light', { host: 'other.test' });
      await expect.poll(() => backgroundOf(other)).toBe(WHITE);
    },
  );
});

test('a subdomain choice overrides its parent', async () => {
  await withSites(
    { routes: { '/': await fixture('media-rule.html') }, hosts: SITES },
    async ({ vm, open }) => {
      const parent = await open('light', { host: 'example.test' });
      await choose(vm.context, vm.extensionId, parent, 'Dark for');
      await expect.poll(() => backgroundOf(parent)).toBe(BLACK);

      const docs = await open('light', { host: 'docs.example.test' });
      await expect.poll(() => backgroundOf(docs)).toBe(BLACK);
      await choose(vm.context, vm.extensionId, docs, 'Light for');
      await expect.poll(() => backgroundOf(docs)).toBe(WHITE);
      await choose(vm.context, vm.extensionId, docs, 'Browser default for');
      await expect.poll(() => backgroundOf(docs)).toBe(WHITE);
      expect(await menuEntries(vm, docs)).toContain(
        `✓ Browser default for docs.example.test ${RELOADS}`,
      );

      await parent.reload();
      await expect.poll(() => backgroundOf(parent)).toBe(BLACK);
    },
  );
});

test('menu has four entries and marks the active one', async () => {
  await withSite(PLAIN_PAGE, async ({ vm, open }) => {
    const page = await open('light');
    expect(await menuEntries(vm, page)).toEqual([
      `Light for 127.0.0.1 ${RELOADS}`,
      `Dark for 127.0.0.1 ${RELOADS}`,
      `✓ Browser default for 127.0.0.1 ${RELOADS}`,
      'Status',
    ]);
    await choose(vm.context, vm.extensionId, page, 'Dark for');
    expect(await menuEntries(vm, page)).toEqual([
      `Light for 127.0.0.1 ${RELOADS}`,
      `✓ Dark for 127.0.0.1 ${RELOADS}`,
      `Browser default for 127.0.0.1 ${RELOADS}`,
      'Status',
    ]);
  });
});

/**
 * @param {string} text
 * @returns {string[]}
 */
const sentences = (text) => text.trim().split(/(?<=[.!?])\s+/);

const PAUSE_MARK = '<!-- the test server pauses here -->';

/**
 * Serves `html` in two parts, pausing after the pause mark, so the manager injects the
 * script while the page is still loading. Without the pause, a small local page finishes
 * loading before the manager's injection lands.
 * @param {string} html
 * @returns {(req: Request, res: Response) => void}
 */
function pausedAfterMark(html) {
  const at = html.indexOf(PAUSE_MARK) + PAUSE_MARK.length;
  if (at < PAUSE_MARK.length) throw new Error('fixture has no pause mark');
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write(html.slice(0, at));
    setTimeout(() => {
      if (!res.destroyed) res.end(html.slice(at));
    }, 300);
  };
}

/**
 * @param {Page} page
 * @returns {Promise<string | undefined>} The scheme the page's own script read.
 */
const schemeReadByPage = (page) => page.evaluate(() => document.documentElement.dataset.scheme);

const EARLY_WARNING = 'may have checked its theme before the script could run';

test('status explains an early theme check in plain sentences', async () => {
  const routes = { '/': pausedAfterMark(await fixture('early-check.html')) };
  await withSites({ routes }, async ({ vm, open }) => {
    const page = await open('light');
    await choose(vm.context, vm.extensionId, page, 'Dark for');
    expect(await schemeReadByPage(page)).toBe('light');
    const status = await readStatus(vm, page);
    expect(status.trimStart().startsWith('{')).toBe(false);
    expect(status).toContain('Dark is saved for 127.0.0.1.');
    expect(status).toContain(EARLY_WARNING);
    expect(sentences(status).length).toBeGreaterThanOrEqual(2);
    expect(sentences(status).length).toBeLessThanOrEqual(4);
  });
});

test('status says it applied on a normal page', async () => {
  await withSite(await fixture('media-rule.html'), async ({ vm, open }) => {
    const page = await open('light');
    expect(await readStatus(vm, page)).toContain('No choice is saved for 127.0.0.1');
    await choose(vm.context, vm.extensionId, page, 'Dark for');
    await expect.poll(() => backgroundOf(page)).toBe(BLACK);
    const status = await readStatus(vm, page);
    expect(status).toContain('Dark is saved for 127.0.0.1.');
    expect(status).toContain('It applied');
    expect(status).not.toContain('checked its theme before');
    expect(sentences(status).length).toBeGreaterThanOrEqual(2);
    expect(sentences(status).length).toBeLessThanOrEqual(4);
  });
});

test('an unrelated script that ran first does not hide that the page asked later', async () => {
  const routes = { '/': pausedAfterMark(await fixture('late-check.html')) };
  await withSites({ routes }, async ({ vm, open }) => {
    const page = await open('light');
    await choose(vm.context, vm.extensionId, page, 'Dark for');
    expect(await schemeReadByPage(page)).toBe('dark');
    const status = await readStatus(vm, page);
    expect(status).toContain(
      'It applied: this page asked which theme you prefer and was told dark.',
    );
    expect(status).not.toContain(EARLY_WARNING);
  });
});

test('a script still waiting to download does not count as having run', async () => {
  const theme = await fixture('theme.js');
  /** @param {Request} _req @param {Response} res */
  const slowScript = (_req, res) => {
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(theme);
    }, 500);
  };
  const routes = { '/': await fixture('pending-script.html'), '/theme.js': slowScript };
  await withSites({ routes }, async ({ vm, open }) => {
    const page = await open('light');
    await choose(vm.context, vm.extensionId, page, 'Dark for');
    expect(await schemeReadByPage(page)).toBe('dark');
    expect(await readStatus(vm, page)).toBe(
      'Dark is saved for 127.0.0.1. It applied: this page asked which theme you prefer and was told dark.',
    );
  });
});

test('a host written with a trailing dot shares the choice of the same host', async () => {
  const routes = { '/': await fixture('media-rule.html') };
  await withSites({ routes, hosts: ['example.test', 'example.test.'] }, async ({ vm, open }) => {
    const plain = await open('light', { host: 'example.test' });
    await choose(vm.context, vm.extensionId, plain, 'Dark for');
    await expect.poll(() => backgroundOf(plain)).toBe(BLACK);

    const dotted = await open('light', { host: 'example.test.' });
    await expect.poll(() => backgroundOf(dotted)).toBe(BLACK);
    expect(await menuEntries(vm, dotted)).toContain(`\u2713 Dark for example.test ${RELOADS}`);
  });
});

const STRICT_CSP =
  "default-src 'none'; script-src 'nonce-t'; style-src 'nonce-t'; require-trusted-types-for 'script'";

test('strict CSP page still applies or explains why', async () => {
  const html = await fixture('csp-edge.html');
  /** @param {Request} _req @param {Response} res */
  const strict = (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': STRICT_CSP,
    });
    res.end(html);
  };
  await withSites({ routes: { '/': strict } }, async ({ vm, open }) => {
    const page = await open('light');
    await choose(vm.context, vm.extensionId, page, 'Dark for');
    const applied = await expect
      .poll(() => backgroundOf(page))
      .toBe(BLACK)
      .then(
        () => true,
        () => false,
      );
    const status = await readStatus(vm, page);
    if (applied) {
      expect(await prefersDark(page)).toBe(true);
      expect(status).not.toContain('could not run inside this page');
    } else {
      expect(status).toContain('Content Security Policy');
    }
  });
});

const STYLED_FEED = [
  '<?xml version="1.0"?>',
  '<?xml-stylesheet type="text/css" href="feed.css"?>',
  '<rss version="2.0"><channel><title>feed</title></channel></rss>',
].join('\n');

test('an XML document produces no script errors', async () => {
  /** @param {Request} _req @param {Response} res */
  const feed = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(STYLED_FEED);
  };
  /** @param {Request} _req @param {Response} res */
  const feedStyle = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('rss { display: block; color-scheme: light dark; }');
  };
  const routes = { '/': PLAIN_PAGE, '/feed.xml': feed, '/feed.css': feedStyle };
  await withSites({ routes }, async ({ vm, open }) => {
    const page = await open('light');
    await choose(vm.context, vm.extensionId, page, 'Dark for');

    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
        errors.push(message.text());
    });
    await page.goto(`${new URL(page.url()).origin}/feed.xml`);
    expect(await page.evaluate(() => document.documentElement.localName)).toBe('rss');
    expect(await menuEntries(vm, page)).toContain('Status');
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });
});
