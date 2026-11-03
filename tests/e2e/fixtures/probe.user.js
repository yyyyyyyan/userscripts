// ==UserScript==
// @name        E2E probe
// @namespace   yyyyyyyan/e2e-probe
// @version     0.0.0
// @description Counts page loads in GM storage and exposes the count on the page.
// @match       http://127.0.0.1/*
// @grant       GM_getValue
// @grant       GM_setValue
// ==/UserScript==

const n = GM_getValue('n', 0) + 1;
GM_setValue('n', n);
document.documentElement.dataset.probe = String(n);
