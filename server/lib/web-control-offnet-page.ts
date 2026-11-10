/**
 * W1 (audit 02 F1): what a browser sees when it opens /control from outside Tailscale (home Wi-Fi, a coffee shop).
 *
 * The answer stays 403. Only the body changes: a page that says why and what to do, in place of one line of plain text.
 * It is fixed text with no script, no link, no name, no address and no version, so it tells a stranger on the same network
 * nothing the old text did not ("available on this Mac and over Tailscale"). It never offers a LAN way in: COS Control Web
 * is Tailscale only unless the owner sets COS_WEB_CONTROL_LAN=1 on the Mac (lib/web-session-auth.ts isWebControlSocketAllowed).
 *
 * A request that does not ask for HTML (an asset, a fetch) keeps the plain text line, so nothing that parses it changes.
 */
export const WEB_CONTROL_OFFNET_TEXT = 'COS Control Web is available on this Mac and over Tailscale.'

/** Its own policy: no script, no outside request, inline style only. Replaces nothing for pages that pass the socket check. */
export const WEB_CONTROL_OFFNET_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export const WEB_CONTROL_OFFNET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Open COS over Tailscale</title>
<style>
:root { color-scheme: light dark; --bg: #f6f5f2; --ink: #1d1c1a; --sub: #5d5a54; --card: #ffffff; --line: #e3e0da; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --ink: #f1efea; --sub: #a9a59d; --card: #1f1e1c; --line: #34322e; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 520px; margin: 0 auto; padding: max(28px, env(safe-area-inset-top)) 16px 40px; }
h1 { font-size: 24px; line-height: 1.25; margin: 0 0 12px; }
p { margin: 0 0 14px; color: var(--sub); }
ol { margin: 0 0 18px; padding: 16px 16px 16px 36px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
li { margin: 0 0 10px; }
li:last-child { margin-bottom: 0; }
strong { color: var(--ink); }
</style>
</head>
<body>
<main>
<h1>Open COS over Tailscale</h1>
<p>This is COS Control Web. It only opens over Tailscale, so it stays hidden from everyone else on this network.</p>
<ol>
<li>Install <strong>Tailscale</strong> on this phone or computer, and sign in with the same account your Mac uses.</li>
<li>Turn Tailscale on.</li>
<li>Open the COS link again. To get a new one, open COS Control Settings on your Mac and choose <strong>Open COS on your phone</strong>.</li>
</ol>
<p>Nothing was sent and you are not signed in.</p>
</main>
</body>
</html>
`

/** The 403 body for a request outside Tailscale: the page for a browser, the old line for anything else. */
export function webControlOffnetResponse(acceptsHtml: boolean): { type: 'html' | 'text'; body: string; csp: string | null } {
  return acceptsHtml
    ? { type: 'html', body: WEB_CONTROL_OFFNET_HTML, csp: WEB_CONTROL_OFFNET_CSP }
    : { type: 'text', body: WEB_CONTROL_OFFNET_TEXT, csp: null }
}
