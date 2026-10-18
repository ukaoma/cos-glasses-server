/**
 * 6.78.0: the ONE reader for every 6.78.0 switch (P7 S3). Before it, the Sessions switches
 * took only an exact `1` or `0` while the Messages and crash-loop switches also took
 * `true`/`false`/`on`/`off`, so `COS_QUEUE_RECONCILE=false` read ON.
 *
 * `1`, `true` or `on` force a switch on; `0`, `false` or `off` force it off; case and
 * surrounding space are ignored. Anything else (unset or empty included) is the switch's
 * DEFAULT. Callers read it at call time, so a restart applies a change.
 *
 * Pure, no imports: the Pi Durable canaries load modules that use it.
 */
export function readSwitch(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'on') return true
  if (value === '0' || value === 'false' || value === 'off') return false
  return fallback
}
