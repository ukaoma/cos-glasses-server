# LAN first: the server contract (6.88.0)

The server half of the glasses "LAN first" reconnect plan (2026-10-22, decisions of 2026-10-23). The phone
reaches the Mac over the home network first and over Tailscale second. The server adds two things, both
additive and both capability gated:

1. `GET /api/route-proof`, a public identity proof, so the phone can check WHICH Mac answers at an address
   before it sends `X-Cos-Token` there.
2. `routes` on authenticated `GET /api/models`: the addresses this Mac answers on, re-learned after a DHCP change.

An older server has neither capability flag. A phone must then keep today's single stored URL and change
nothing. `COS_LAN_FIRST=0` in the server environment turns both pieces off (read per request).

## Capability flags

Published on `GET /api/health` (public) and `GET /api/models` (token) under `capabilities`, from one helper,
so the two surfaces always agree:

```json
"routeProof": { "protocol": 1 },
"lanRoutes":  { "protocol": 1 }
```

| Flag | Present when | Absent means |
|---|---|---|
| `routeProof` | the switch is on, the server instance id is minted, and the token is at least 32 characters | do not call `/api/route-proof`; never send the token to an unproven address |
| `lanRoutes` | the switch is on | `/api/models` will not carry `routes` |

Public health carries only these flags. It never carries an address.

## `GET /api/route-proof?nonce=<nonce>`

Public: no `X-Cos-Token`. GET only.

### Request

| Part | Rule |
|---|---|
| `nonce` | exactly one query parameter, 22 to 64 characters of base64url (`A-Z a-z 0-9 - _`), no padding. Fresh random per request; 16 random bytes encode to 22 characters. |
| Headers | none needed. Do not send `X-Cos-Token` to an address you have not proven. |
| Timeout | the plan's 1.5 s for a LAN proof. |

### Success: `200`

```json
{ "v": 1, "serverInstanceId": "<uuid v4>", "proof": "<64 lowercase hex>" }
```

`Cache-Control: no-store`.

### The HMAC

```
message = "cos-route-proof:v1:" + nonce + ":" + serverInstanceId      (UTF-8)
proof   = lowercase hex( HMAC-SHA256( key = token (UTF-8 bytes), message ) )
```

`token` is the exact pairing token string the phone stores (the `X-Cos-Token` value). `serverInstanceId` is the
value in the response, which must also equal the phone's stored `active.serverInstanceId`.

Known-answer vector:

| Input | Value |
|---|---|
| token | `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` |
| nonce | `AAAAAAAAAAAAAAAAAAAAAA` |
| serverInstanceId | `00000000-0000-4000-8000-000000000000` |
| message | `cos-route-proof:v1:AAAAAAAAAAAAAAAAAAAAAA:00000000-0000-4000-8000-000000000000` |
| proof | `445fc7d579849fa3fdfb8c2831cf0ace04c6db74e2817b75e87139cc9a3cd207` |

### Phone-side check (the whole point)

The route counts only if ALL hold, and only then may the phone send `X-Cos-Token` to that address:

1. Status 200 and `v === 1`.
2. `serverInstanceId` equals the stored `active.serverInstanceId`.
3. `proof` equals the phone's own HMAC over the nonce IT generated for this request and the STORED id.

Anything else (timeout, any other status, a body that does not parse, a mismatch) means "not my Mac": drop that
address for this cycle and never send the token there. Compare in constant time where the platform offers it;
the comparison happens on the phone, so there is no remote timing oracle either way.

### Errors

Every error body is `{ "v": 1, "reason": "<code>" }` with `Cache-Control: no-store`.

| Status | `reason` | When | Phone should |
|---|---|---|---|
| 400 | `bad_nonce` | nonce missing, repeated, wrong length or charset | fix the client; treat as not proven |
| 401 | (the standard `pairing_token_rejected` body) | any verb other than GET without a token, or any path other than exactly `/api/route-proof` | treat as not proven |
| 404 | `disabled` | `COS_LAN_FIRST=0` | stop LAN proofs until the capability returns |
| 404 | (no body contract) | a server older than 6.88.0 | stop LAN proofs; it has no `routeProof` flag anyway |
| 405 | `method_not_allowed` | a non-GET verb that carried a valid token. `Allow: GET` | fix the client |
| 429 | `rate_limited` | over the limit below. `Retry-After` in seconds | wait `Retry-After`, keep the current route |
| 503 | `not_ready` | the instance id is not minted yet (still binding after a restart), or the token is too short to expose. `Retry-After: 30` | keep the current route, retry later |
| 403 | (network filter) | the caller is not on loopback, Tailscale or a private network | treat as not proven |

### Rate limit

Per socket address (never `X-Forwarded-For`): 20 requests in any 60 s window. Global: 240 in any 60 s window
across all addresses. Bad-nonce requests spend the same budget. The plan's phone schedule (boot, foreground,
reconnect, then one every 60 s while on Tailscale) stays far below it.

## `routes` on `GET /api/models` (token)

```json
"routes": {
  "v": 1,
  "serverInstanceId": "<uuid v4, same as top-level serverInstanceId>",
  "learnedAt": "<ISO time the interfaces were read>",
  "lan":       [ { "ip": "192.168.1.204",   "port": 3141, "scheme": "http" } ],
  "tailscale": [ { "ip": "100.108.149.114", "port": 3141, "scheme": "http" } ]
}
```

| Field | Rule |
|---|---|
| `lan` | RFC1918 IPv4 (10/8, 172.16/12, 192.168/16) on a non-internal interface that is not a tunnel, bridge or VM network (`utun`, `tun`, `tap`, `ipsec`, `ppp`, `bridge`, `awdl`, `llw`, `vmnet`, `vboxnet`, `docker`, `br-`, `veth`, `virbr`, `lxc`, `lxd`, `cni`, `flannel`, `podman`, `cali`, `vnic`, `tailscale` are left out). Link-local 169.254/16 and public addresses never appear. |
| `tailscale` | 100.64/10 on Tailscale's own interface (`utun*` on macOS, `tailscale*` elsewhere). A carrier-grade-NAT address on Wi-Fi is not Tailscale and is left out. |
| `port` | the plain-http port (`PORT`, default 3141) for both kinds. HTTPS 3143 is never advertised: its certificate does not cover these addresses. |
| `scheme` | always `http` in protocol 1. |
| MagicDNS name | not published. Reading it means running `tailscale status --json` per request, which is not cheap; a later protocol may add `name`. |
| order | interface order as the OS reports it; at most 8 per list; no duplicates. |
| freshness | read from the interfaces at most every 10 s, so a new DHCP lease shows up on the next read after that. |
| absent | the switch is off, the instance id is not minted, or the interface read failed. The rest of `/api/models` is unchanged in every case. |

Node does not expose interface up/down flags; an address the OS still lists can appear. That is why every
address must pass the route proof before the token goes there.

Replace the stored LAN list each time `/api/models` is read on either path. Never hardcode an address.

## What a stranger can learn

| Surface | Without the token |
|---|---|
| `/api/route-proof` | the instance id (already public on `/api/health` as `server_instance_id`), an HMAC of a message it cannot choose, and whether the token is long enough to be proven (it gets `not_ready` otherwise) |
| `/api/health` | the two protocol flags |
| `/api/models` | the standard 401 |

## Security decisions

- **No token oracle.** The caller chooses only the nonce, its charset has no `:`, and the message always starts with
  the fixed prefix and ends with the server's own id. The only other HMAC keyed by the token signs
  `display-stream:<exp>` (display tickets), which can never start with the prefix, so a proof is never a ticket.
- **Offline guessing.** A proof lets anyone who can reach the port test token guesses offline. Server- and
  Control-generated tokens (44 and 64 characters of random) make that hopeless; a token under 32 characters gets no
  proof and no `routeProof` flag, so that install keeps today's behaviour.
- **What the proof does and does not stop.** It stops the token going to a DIFFERENT machine at a remembered
  address (someone else's Wi-Fi, a reused DHCP lease). It does not stop an active attacker on the same Wi-Fi who relays
  the proof request to the real Mac: the LAN path is plain HTTP, so the token crosses the home network unencrypted, as
  a pasted token and "Allow pairing on this Wi-Fi" already do. Over Tailscale the traffic is encrypted.
- **Nothing logged.** The route never logs or echoes the nonce or the proof.
- **No state on disk.** The rate limiter is in memory; a restart clears it.

## Not in this release

Phase 3 of the plan (a loopback `GET /api/glasses/link` for COS Control's banner) is not built: it needs new
tracking of the client's last path and check-in time, so it is not a trivially additive change.
