---
name: office-integrations
description: Use when building or fixing anything the owner clicks in the office that leaves it — "Sign in with Google/Microsoft/Slack" (OAuth), links, pop-ups, downloads — or any Zoo integration. The owner uses the office in the Mac app (AI Office.app), not a browser, and that changes how pop-ups and links behave.
---

# Office integrations and the Mac app

## The owner's office is a Mac app, not a browser tab

`AI Office.app` (`office-app/main.swift`, built by `sm app`) shows the office in a WKWebView. It has **no pop-up
windows**:
- `window.open(url)` / `target=_blank` with an `http(s)` web address → opens in the owner's default browser.
- An office address (127.0.0.1 / localhost) → loads in the app's own window.
- Anything else (`about:blank`, `javascript:`, …) → dropped. Handing it to macOS used to show "There is no
  application set to open the URL about:blank".
- The page can tell it is in the app: `navigator.userAgent` contains `AIOffice/`.

So the browser trick "open a blank pop-up inside the click, then point it at the real URL after an await"
**fails in the app**. In the app, call `window.open(realUrl, '_blank')` once you have the URL. There is no
`window.opener` either: the browser tab can't message the office back, so poll the server for the result
(e.g. `smClient.integrations.list()` until `oauth.signedIn`).

## OAuth sign-in flow (Zoo cards)

`bin/integrations.js`:
1. `oauthStart` builds the consent URL with the redirect `http://127.0.0.1:4777/sm/oauth/callback`.
2. The owner signs in in their browser.
3. `/sm/oauth/callback` (no token, guarded by a one-time `state`) stores the refresh token.
4. `check` proves it with a real token refresh.

**Google uses the owner's Firebase project. Never ask the owner for client IDs or secrets.** When Firebase is
linked (`office/firebase-link.json`), `appFor` fetches the Google sign-in app that Firebase made
(Authentication → Google) through `firebase.googleClient()`, using the service-account key, and remembers it.
The card then shows only "Sign in with Google".

Before sending the owner to Google, `oauthStart` asks Google whether it will accept the office's return
address. If not (`redirect_uri_mismatch`), it answers 409 with a message naming the address and a `fixUrl` to
that app's settings page; the card shows it as a link. Adding the address there is a one-time owner step:
Google allows no API for it. If Google says "app not verified", the owner clicks Advanced → Continue (it's their
own app). Tell the owner the one exact thing to do; don't guess at keys.

## Verify in the surface the owner uses

`sm office --browse` drives a browser, which hides app-only bugs like the one above. For anything that opens
links or pop-ups:
- Read `createWebViewWith` / `decidePolicyFor` in `office-app/main.swift` and check what your URL will hit.
- If you changed `main.swift`, rebuild with `sm app --no-dock` and say the owner must quit and reopen the app.

Never call a sign-in "working" until the button's whole path, in the app, ends on the provider's page.
