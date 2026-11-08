// What this deployment is configured with. To run your own registry of themes and extensions, change the address below (or fork
// this file): the registry is a folder of static files, themes.json and extensions.json, in any repository or host that serves
// them, and the app falls back to its bundled snapshot (registry-snapshot.json) when it cannot be reached.
export const config = Object.freeze({
  // a static address ending in "/": no API, no authentication, nothing rate limited per address
  registry: 'https://raw.githubusercontent.com/tejaswigowda/blog-registry/main/',
  // "Sign in with GitHub" (templates/oauth-worker/README.md): a GitHub App's client id, the exchange proxy's address and the App's slug.
  // Left empty, the sign-in dialog offers only the fine-grained token.
  oauth: { clientId: '', proxy: '', app: '' },
});
