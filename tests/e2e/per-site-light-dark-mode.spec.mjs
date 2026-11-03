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
 * @param {string} path
 * @param {string} html
 * @param {(ctx: {
 *   vm: Awaited<ReturnType<typeof launchWithViolentmonkey>>,
 *   open: (scheme: Scheme) => Promise<Page>,
 * }) => Promise<void>} body
 */
async function withSite(path, html, body) {
  const site = await serve({ [path]: html });
  const vm = await launchWithViolentmonkey();
  try {
    await vm.install(script);
    await body({
      vm,
      async open(scheme) {
        const page = await vm.context.newPage();
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`${site.origin}${path}`);
        return page;
      },
    });
  } finally {
    await vm.close();
    await site.close();
  }
}

test('matchMedia page follows the saved choice in both directions', async () => {
  await withSite('/', await fixture('matchmedia.html'), async ({ vm, open }) => {
    const lightBrowser = await open('light');
    await expect(lightBrowser.locator('body')).toHaveAttribute('data-scheme', 'light');
    await choose(vm.context, vm.extensionId, lightBrowser, 'Prefer dark');
    await expect(lightBrowser.locator('body')).toHaveAttribute('data-scheme', 'dark');
    expect(await backgroundOf(lightBrowser)).toBe(BLACK);
    await lightBrowser.close();

    const darkBrowser = await open('dark');
    await expect(darkBrowser.locator('body')).toHaveAttribute('data-scheme', 'dark');
    await choose(vm.context, vm.extensionId, darkBrowser, 'Prefer light');
    await expect(darkBrowser.locator('body')).toHaveAttribute('data-scheme', 'light');
    expect(await backgroundOf(darkBrowser)).toBe(WHITE);
  });
});

test('CSS media rules follow the saved choice in both directions', async () => {
  await withSite('/', await fixture('media-rule.html'), async ({ vm, open }) => {
    const lightBrowser = await open('light');
    expect(await backgroundOf(lightBrowser)).toBe(WHITE);
    await choose(vm.context, vm.extensionId, lightBrowser, 'Prefer dark');
    await expect.poll(() => backgroundOf(lightBrowser)).toBe(BLACK);
    await lightBrowser.close();

    const darkBrowser = await open('dark');
    expect(await backgroundOf(darkBrowser)).toBe(BLACK);
    await choose(vm.context, vm.extensionId, darkBrowser, 'Prefer light');
    await expect.poll(() => backgroundOf(darkBrowser)).toBe(WHITE);
  });
});

test("the site's own switch wins once used", async () => {
  await withSite('/', await fixture('ld-toggle.html'), async ({ vm, open }) => {
    const page = await open('light');
    expect(await backgroundOf(page)).toBe(WHITE);
    await choose(vm.context, vm.extensionId, page, 'Prefer dark');
    await expect.poll(() => backgroundOf(page)).toBe(BLACK);
    await page.locator('#light').click();
    await expect.poll(() => backgroundOf(page)).toBe(WHITE);
  });
});
