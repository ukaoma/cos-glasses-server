// X1 (iPhone pings): whether index.ts mounted the push routes at boot (COS_WEB_PUSH on). /api/health's
// `features.webPush` reads THIS, never the environment, so it says whether the routes exist in the running server
// (W1's Settings button shows only then). Set once at boot; nothing else writes it.

let mounted = false

/** index.ts, right after it mounts createWebPushRouter (only with COS_WEB_PUSH on at boot). */
export function markWebPushRoutesMounted(): void {
  mounted = true
}

export function webPushRoutesMounted(): boolean {
  return mounted
}

export function __resetWebPushMountedForTests(): void {
  mounted = false
}
