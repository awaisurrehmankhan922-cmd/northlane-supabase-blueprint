# Desktop app (PWA)

Two files make the hosted CRM installable from the Windows Start menu, the Mac Dock or a phone's home screen.

| File | What it does |
|---|---|
| `manifest.webmanifest` | Name, icons, colours, standalone window, shortcuts. Linked from `index.html` with `<link rel="manifest">`. |
| `sw.js` | Caches the app shell only (scripts, styles, fonts, logos). Never `/api/`, `/files/`, `/sign/`. New deploy = new cache; old one removed. |

## Fitting the CSP

The service worker is a separate file registered from `js/app/core.js`, so no inline script is needed:

```js
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js', { scope: '/' });
}
```

Add `worker-src 'self'` to the Content-Security-Policy. The pinned vendor files keep their `integrity` attributes; the worker caches them as served, so the hash still checks on load.

## Deploy

`__BUILD_ID__` in `sw.js` is replaced with the git sha at deploy (`npm run build:pwa`). Browsers see a byte-different worker, install it, and the `activate` step deletes the old shell cache. Open tabs reload on the next navigation; nothing in flight is lost because saves never pass through the worker.

## Signing out when the window closes

Unchanged: the session is a server cookie ended when the browser closes, on idle, and after 12 hours. The worker never reads cookies or API responses. A test in `test/06-pwa.test.js` fails the build if `sw.js` ever lists a data path in its shell.
