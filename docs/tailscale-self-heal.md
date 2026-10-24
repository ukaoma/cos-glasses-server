# Tailscale self-heal (server 6.89.0)

COS is used away from home, over Tailscale. The problem this solves: after the Mac restarts, wakes
from sleep, restarts Tailscale or changes network, the phone can stay on a stale Tailscale tunnel.
Tailscale says the phone is online and its own ping gets through, yet no COS request arrives, and
the only fix used to be toggling Tailscale on the phone. 6.89.0 adds a bounded Mac-side "nudge" and
a contract for the phone side. Code: `server/lib/tailscale-nudge.ts`.

6.89.0 also removes 6.88.0's LAN-first pieces (`GET /api/route-proof`, `routes` on `/api/models`,
`capabilities.routeProof` and `capabilities.lanRoutes`, `COS_LAN_FIRST`). Tailscale already takes
the direct path over the home Wi-Fi when both ends are home, so a separate LAN route added nothing
for the away-from-home case. `COS_LAN_FIRST` is now read by nothing.

## What the Mac can see (read-only probes, 2026-10-23, Tailscale 1.102.2 on macOS)

`tailscale status --json`, the phone's peer entry while COS was working normally:

| Field | Value seen | What it tells us |
|---|---|---|
| `Online` | `true` | Control-plane presence. It stays true while the iOS extension runs, stale tunnel or not, so on its own it proves nothing about the data path. |
| `Active` | `true` | Recent traffic in the engine. |
| `CurAddr` | the phone's home Wi-Fi address and port | A direct path. Away from home it is a public address, or empty when relayed. |
| `Relay` | the home DERP region | The fallback relay. |
| `LastHandshake` | 60 s old, refreshing about every 2 minutes | The WireGuard session is being renewed. A handshake much older than about 3 minutes while `Active` is true is suspicious. |
| `LastSeen` | zero time | Only set while the peer is offline. |
| `RxBytes` / `TxBytes` | grew by about 9 KB and 18 KB in 12 s | Per-peer counters for the life of tailscaled. They reset when tailscaled restarts, which is how the server detects a Mac-side Tailscale restart. |

`tailscale ping -c 3 --timeout 5s <phone>` answered once, `via <home address>:41641 in 91ms`, and
stopped: it stops at the first direct pong. `tailscale ping --icmp -c 1 --timeout 5s <phone>`
answered `via ICMP in 27ms`. The CLI's own help says the plain (disco) ping does not go through the
tunnel; the `--icmp` ping does go through WireGuard.

The local signal for "the peer looks online but no COS request has arrived": the server's own last
request time from that Tailscale address (any `/api` request, public routes included, because any
request that arrives proves the tunnel carries COS traffic), together with `Online: true` from a
status read no more than 15 s old. Each nudge log line also records the peer's handshake age and its
`RxBytes` movement between the last two status reads, so the field canary can show which of them
tells a stuck tunnel apart. The stuck state itself was not reproduced here.

## The nudge

A nudge is two bounded commands at one peer, run with `execFile` from a fixed path (never a shell,
never a PATH lookup):

1. `tailscale ping -c 3 --timeout 5s <peer>`: a disco ping. Both ends redo path discovery.
2. Only after a pong: `tailscale ping --icmp -c 1 --timeout 5s <peer>`: one packet through
   WireGuard, which makes WireGuard start a fresh handshake when its session is stale. On 10/22 the
   disco ping got through while COS did not, so the disco ping alone is not enough.

The CLI is looked for at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
`/opt/homebrew/bin/tailscale`, `/usr/local/bin/tailscale` and `/usr/bin/tailscale`, in that order.
Without one the loop does nothing and health says `available: false`.

Whether a Mac-side nudge un-sticks the iOS extension is not proven by tests. The field canary below
is the proof.

### Triggers

Every trigger needs the positive signal: the peer is `Online` in a status read at most 15 s old, and
Tailscale's `BackendState` is `Running`. Absence of requests alone never nudges.

| Trigger | When | Who |
|---|---|---|
| `boot` | 30 s after the server starts | Event peers (below) |
| `wake` | The wall clock moved 20 s or more past the monotonic clock between two 10 s ticks, which only happens across a sleep. Runs 15 s later. | Event peers |
| `network` | This Mac's external IPv4 interfaces changed, Tailscale's tunnel interface included. Runs 10 s later. | Event peers |
| `tailscale` | Tailscale's own state changed between status reads: `BackendState`, this Mac's Tailscale IPs, or the peer byte counters went backwards (tailscaled restarted). Runs 10 s later. | Event peers |
| `silent` | A Tailscale address that made an authenticated request in the last 5 minutes, or sent meeting chunks in the last 15 minutes while a meeting is open, has made no request at all for 45 s. | That address |

Event peers: Online peers this server has seen authenticate in the last 12 hours, plus Online iOS
and Android peers (after a restart the server remembers no one), at most 4, known ones first. A peer
that has already made a request since the event is skipped. An event that cannot run because
Tailscale is not `Running` waits, and is dropped (with one log line) after 2 minutes.

### Caps

- One nudge per peer per 60 s. Each nudge that brings no request doubles the gap: 60, 120, 240,
  480 s, then 900 s. Any request from that peer resets it.
- 30 nudges an hour in all, across peers.
- One pass at a time; each command has a hard timeout (status 5 s, disco 20 s, ICMP 10 s, killed
  with SIGKILL).
- A quiet phone outside a meeting is nudged at most 3 times (at about 45 s, 1:50 and 3:50) before its
  5-minute window closes. In a meeting, at most 4 in 15 minutes.
- Status is read once a minute while the loop is on, and otherwise only when a nudge could run.
- `COS_TAILSCALE_NUDGE=0` (or `false`, `off`) stops all of it, read every tick. On by default.
  Forwarded by the managed runtime contract.
- No LLM, no disk write, no new route.

### What it says

Log lines, outcome and timing only, never an address:

```
[tailscale-nudge] trigger=silent outcome=pong_direct dataPath=ok pingMs=91 icmpMs=27 silentS=50 handshakeAgeS=61 rxDelta=9040/60s inRow=1 lastHour=1
[tailscale-nudge] peer answered 4.2s after the silent nudge
[tailscale-nudge] trigger=wake dropped: Tailscale not running for 121s
```

`outcome` is `pong_direct`, `pong_relay`, `no_pong`, `timeout`, `error` or `unavailable`.
`dataPath` is `ok`, `failed` or `skipped` (no ICMP ping without a disco pong). A failed ping also
logs `code`, `signal` and `killed`.

Public `/api/health` carries:

```json
"tailscaleNudge": {
  "enabled": true,
  "available": true,
  "lastAt": "2026-10-23T20:05:10.000Z",
  "lastTrigger": "silent",
  "lastOutcome": "pong_direct",
  "lastDataPath": "ok",
  "lastRecoveredAt": "2026-10-23T20:05:14.200Z",
  "nudgesLastHour": 1
}
```

`available` is `null` until the first look for the CLI. `lastRecoveredAt` is when a nudged peer next
made a request, if that was within 90 s of the nudge. No address or device name is published.

## The phone side (contract for glasses 6.10.653; not built in this release)

- **Retry with a fresh request.** On a reconnect failure, retry `/api/health` and then the
  authenticated `/api/models` with `cache: 'no-store'` and a cache-busting query, on a fresh
  connection where the WebView allows it (do not reuse a stalled keep-alive socket; a new
  `EventSource` for the display stream). Backoff ladder: 2, 4, 8, 15, then every 30 s while the app
  is in the foreground. Never a tight loop.
- **Wait out the Mac-side window before blaming Tailscale.** The Mac's nudge fires 45 s into a
  silence (or 30 s after a Mac boot, 15 s after a wake) and its pings take up to about 30 s. Show
  6.10.652's stuck-Tailscale message only after 90 s of failed fresh requests while the phone has
  network (the gotcos.com reachability check). Before that, show the ordinary reconnecting state.
- **Read the outcome.** `/api/health` is public, so once the phone reaches it, `tailscaleNudge`
  tells it whether the Mac nudged and when. If health is reachable but authenticated calls are not,
  the tunnel is fine and the problem is elsewhere: do not show the Tailscale message.
- **Keep working offline.** Local-first capture and backfill are unchanged: record locally, upload
  when the Mac answers.
- **What to tell Miles about VPN On Demand.** In the iOS Tailscale app (Settings, VPN On Demand),
  turning it on makes iOS bring the tunnel back by itself after it drops, for example after a network
  change. It is a phone setting he can choose; COS cannot change it. It does not replace the nudge: a
  tunnel iOS considers "up" but stale is not a drop, which is the case the Mac-side nudge targets.

## Field canary (Miles)

1. Note the time. Phone on cellular or away from home, COS open on the phone, Tailscale on.
2. On the Mac, either quit and reopen Tailscale (menu bar, Quit, then open it), or restart the Mac.
3. Do not touch Tailscale on the phone. Use COS on the phone within about two minutes.

Success:

- **Log** (the server log; with COS Control, `~/Library/Logs/COS Glasses/server.log`): a `[tailscale-nudge] trigger=tailscale` (Tailscale restart) or
  `trigger=boot` (Mac restart) line with `outcome=pong_direct` or `pong_relay` and `dataPath=ok`,
  then `peer answered ...s after the ... nudge`.
- **Health:** `curl -s http://127.0.0.1:3141/api/health` shows `tailscaleNudge.lastTrigger` matching,
  `lastOutcome` a pong, and `lastRecoveredAt` set a few seconds after `lastAt`.
- **Phone:** COS reconnects by itself, without a Tailscale toggle, and a meeting started before the
  restart keeps its chunks (transfer integrity 100%).

If the phone still needs a toggle: record the nudge log line (its `handshakeAgeS` and `rxDelta` are
the evidence for the next step) and the time of the toggle.
