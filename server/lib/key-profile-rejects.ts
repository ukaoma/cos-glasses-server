// Key lanes K1, package P6 (plan v4 5.2): the explicit rejects, as a leaf module. The scheduled
// brief, task dispatch and Work paths import only this (never conversation or model-router), so
// importing it changes nothing at module load for a server with key lanes off.
//
// A reject applies only to a well formed `profile:<id>` (a pure string test) AND only while key
// lanes are enabled. With lanes off, the input falls through to the site's existing closed
// refusal, byte for byte as 6.79.0 answers it.
import { keyLanesEnabled } from './key-lanes.js'
import { isProfilePreference } from '../../shared/key-preference.js'

/** Plan 5.2: morning brief and task dispatch. */
export const KEY_PROFILE_SCHEDULED_REJECT = 'Key profiles cannot run scheduled briefs.'
/** Plan 5.2: Work handoff requests and drafts, K1. */
export const KEY_PROFILE_WORK_REJECT = 'Key sessions are not in Work yet.'
/** The error code the rejecting routes answer with. */
export const KEY_PROFILE_REJECT_CODE = 'key_profile_not_allowed'

/** True when `value` names a key profile and the site should say so instead of its generic refusal. */
export function keyProfileRejectApplies(value: unknown): boolean {
  return isProfilePreference(value) && keyLanesEnabled()
}
