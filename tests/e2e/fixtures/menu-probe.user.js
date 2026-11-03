// ==UserScript==
// @name        E2E menu probe
// @namespace   yyyyyyyan/e2e-menu-probe
// @version     0.0.0
// @description Registers one menu command that marks the page.
// @match       http://127.0.0.1/*
// @grant       GM_registerMenuCommand
// ==/UserScript==

GM_registerMenuCommand('Mark the page', () => {
  document.documentElement.dataset.menuClicked = 'yes';
});
