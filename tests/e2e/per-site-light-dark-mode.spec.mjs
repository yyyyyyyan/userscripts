import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

import { launchWithViolentmonkey, openMenu, serve } from './harness.mjs';

/**
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {'light' | 'dark'} Scheme
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
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} extensionId
 * @param {Page} page
 * @param {string} label
 */
async function choose(context, extensionId, page, label) {
  const popup = await openMenu(context, extensionId, page);
  const reloaded = page.waitForEvent('load');
  await popup.getByText(label).click();
  await reloaded;
  await popup.close();
}

/**
 * @param {string} html
 * @param {(ctx: {
 *   vm: Awaited<ReturnType<typeof launchWithViolentmonkey>>,
 *   open: (scheme: Scheme) => Promise<Page>,
 * }) => Promise<void>} body
 */
async function withSite(html, body) {
  const site = await serve({ '/': html });
  const vm = await launchWithViolentmonkey();
  try {
    await vm.install(script);
    await body({
      vm,
      async open(scheme) {
        const page = await vm.context.newPage();
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`${site.origin}/`);
        return page;
      },
    });
  } finally {
    await vm.close();
    await site.close();
  }
}

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
    await choose(context, extensionId, lightBrowser, 'Prefer dark');
    await expect.poll(() => read(lightBrowser)).toEqual(expected.dark);
    await lightBrowser.close();

    const darkBrowser = await open('dark');
    await choose(context, extensionId, darkBrowser, 'Use browser default');
    await expect.poll(() => read(darkBrowser)).toEqual(expected.dark);
    await choose(context, extensionId, darkBrowser, 'Prefer light');
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
    await choose(vm.context, vm.extensionId, page, 'Prefer dark');
    await expect.poll(() => backgroundOf(page)).toBe(BLACK);
    await page.locator(button).click();
    await expect.poll(() => backgroundOf(page)).toBe(WHITE);
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
    await choose(vm.context, vm.extensionId, page, 'Prefer dark');
    await expect.poll(() => backgroundOf(page)).toBe(BLACK);

    /** @returns {Promise<string>} */
    const rootColorScheme = async () => {
      const dialog = page.waitForEvent('dialog');
      const popup = await openMenu(vm.context, vm.extensionId, page);
      await popup.getByText('Show color preference status').click();
      const shown = await dialog;
      await shown.accept();
      await popup.close();
      return JSON.parse(shown.message()).rootColorScheme;
    };

    expect(await rootColorScheme()).toBe('dark');

    await page.evaluate(() => {
      document.adoptedStyleSheets = [];
    });
    await expect.poll(() => backgroundOf(page)).toBe(WHITE);
    expect(await rootColorScheme()).toBe('unchanged');

    await page.evaluate(() => {
      document.documentElement.dataset.touched = 'yes';
    });
    await expect.poll(() => backgroundOf(page)).toBe(BLACK);
    expect(await rootColorScheme()).toBe('dark');
  });
});
