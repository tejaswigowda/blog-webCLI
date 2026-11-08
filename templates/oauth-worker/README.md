# Sign in with GitHub: setup

The editor can sign you in with GitHub instead of a pasted token. Behind the button is a **GitHub App** (not an OAuth App): the token it
gets can act only on the repositories you install the app on, with only the permissions the app declares, which is the reach of a
fine-grained token, chosen on GitHub's own page. The personal-access-token form stays, under *Use a token instead*.

GitHub cannot create or manage fine-grained personal access tokens through any API, so this does not mint one: it uses the App's
user-to-server token, which is the same idea with a login.

A static page cannot finish the login by itself: exchanging GitHub's code for a token needs the app's client secret, and GitHub's token
endpoint sends no CORS headers. `worker.js` is that exchange and nothing more (token, refresh, revoke). It stores and logs nothing.

## One-time setup (whoever runs the editor)

1. **Create the GitHub App** (github.com/settings/apps/new):
   * Callback URL: the editor's address, e.g. `https://blog.webcli.app/` (add `http://localhost:5504/` to try it locally).
   * Setup URL: the same address, and tick *Redirect on update*.
   * Expire user authorization tokens: **on** (8-hour tokens, refreshed silently).
   * Webhook: off.
   * Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Pages: Read-only**, **Metadata: Read-only**.
   * Where can it be installed: *Any account*.
   Then generate a **client secret**.
2. **Deploy the proxy**: `cd templates/oauth-worker`, put the client id in `wrangler.toml`, `npx wrangler secret put CLIENT_SECRET`,
   `npx wrangler deploy`.
3. **Point the editor at it** in `app/config.js`: `oauth: { clientId, proxy, app }` (`app` is the App's slug), then `node cli/build-live.js`.

## What a user sees

*Sign in with GitHub* → GitHub asks which repositories to allow (the blog and its asset repositories) → back in the editor, signed in.
*Repository access* in the header reopens that choice. Signing out revokes the token.
