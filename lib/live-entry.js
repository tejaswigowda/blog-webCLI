// Entry point of webcli-live.js: run the checks for the page this script was loaded by.
import { run } from './live.js';

let storage = null;
try {
  storage = window.sessionStorage;
} catch {
  /* blocked: the check simply is not remembered */
}
run({ storage }).catch((e) => {
  document.documentElement.dataset.webcliLive = 'error';
  document.documentElement.dataset.webcliWhy = String((e && e.message) || e);
});
