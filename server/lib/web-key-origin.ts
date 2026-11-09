// The ONE signing origin for the enrolled phone key and its passkey (6.99.31, review B2/W2).
// `expectedOrigin` (the envelope's `origin` and the request Origin header), the passkey's
// `clientDataJSON.origin` check, and the cookie gate's extra port all come from here, so they can
// never name different origins. The plan puts the signer on its own https origin, port 3144, apart
// from the big app on 3143 (transcripts, previews): the key never lives on the 3143 origin.

/** The signer's https port (plan §4.8). */
export const WEB_KEY_SIGNER_PORT = 3144

/** The normalized MagicDNS host (lower case, no trailing dot), or null. */
export function webKeyRpId(selfDnsName: string | null | undefined): string | null {
  if (typeof selfDnsName !== 'string') return null
  const host = selfDnsName.trim().toLowerCase().replace(/\.$/, '')
  return host && /^[a-z0-9.-]+$/.test(host) ? host : null
}

/** `https://<host>:3144`, or null when this Mac's MagicDNS name is unknown. */
export function webKeySignerOrigin(selfDnsName: string | null | undefined): string | null {
  const host = webKeyRpId(selfDnsName)
  return host ? `https://${host}:${WEB_KEY_SIGNER_PORT}` : null
}
