// What each provider can DO through COS (6.62.0, plan 3.11): `providers.<p>.act`.
//
// One object per provider, published on /api/health and /api/models (the phone reads the
// second). Every entry is `{ supported }`, and every `supported: false` carries a reason
// code, so a client never has to invent copy for a missing capability. Computed per request
// from the same live flags the routes decide with; this module decides nothing itself.
//
// The observation half (`providers.<p>.observe`, plan 1.10) is published by the hooks
// work; `mergeProviderSections` joins the two under one `providers` key so neither
// spread can overwrite the other.

import { continueFullPermissionsEnabled } from './continue-plan.js'
import { permissionBrokerHealthFields } from './permission-broker.js'
import { continueLiveEnabled } from './session-peer-inbox-deps.js'
import { codexLiveQueueEnabled } from './codex-live-queue.js'

export type ProviderName = 'claude' | 'codex' | 'cursor'

export interface ProviderCapability {
  supported: boolean
  /** Present exactly when `supported` is false: a stable, enum-like code. */
  reason?: string
  /** Optional qualifier on a supported entry (`new_session`, `next_command`). */
  mode?: string
}

export interface ProviderAct {
  continueIdle: ProviderCapability
  continueBusy: ProviderCapability
  fork: ProviderCapability
  cancelDesk: ProviderCapability
  approvals: ProviderCapability
  nativeQueue: ProviderCapability
  keepModel: ProviderCapability
  permissions: ProviderCapability
}

export interface ProviderActInput {
  /** `threadAttachCapability().enabled`: the write routes exist. */
  attachEnabled: boolean
  /** `threadForkProviders`. */
  forkProviders: readonly string[]
  /** `features.sessionCancel`, whatever keys this build publishes there. */
  sessionCancel: Record<string, unknown> | null | undefined
  /** The permission broker is on (`permissionBroker.enabled`). */
  brokerEnabled: boolean
  /** `COS_CONTINUE_LIVE` (Claude's live hop). */
  continueLive: boolean
  /** `COS_CODEX_LIVE_QUEUE` (Codex's app-queue hop, idle and busy). */
  codexLiveQueue: boolean
  env?: NodeJS.ProcessEnv
}

const yes = (mode?: string): ProviderCapability => (mode ? { supported: true, mode } : { supported: true })
const no = (reason: string): ProviderCapability => ({ supported: false, reason })

/** The three `act` objects. Pure over its input. */
export function providerActs(input: ProviderActInput): Record<ProviderName, ProviderAct> {
  const full = continueFullPermissionsEnabled(input.env)
  const attach = input.attachEnabled === true
  const cancel = input.sessionCancel ?? {}
  const continueIdle = (mode?: string) => (attach ? yes(mode) : no('attach_disabled'))
  const fork = (provider: ProviderName, mode?: string) =>
    (input.forkProviders.includes(provider) ? yes(mode) : no('fork_unsupported'))
  const desk = (key: string) => (cancel[key] === true ? yes('next_command') : no('hooks_not_ready'))
  return {
    claude: {
      continueIdle: continueIdle(input.continueLive ? 'live' : 'resume'),
      // A busy Claude session takes no outside turn mid-run; the turn waits for its Stop.
      continueBusy: no('queued_until_turn_end'),
      fork: fork('claude'),
      cancelDesk: desk('deskClaude'),
      approvals: input.brokerEnabled ? yes() : no('broker_off'),
      nativeQueue: no('engine_limit'),
      keepModel: yes(),
      permissions: yes('session'),
    },
    codex: {
      continueIdle: continueIdle(input.codexLiveQueue ? 'app_queue' : 'resume'),
      continueBusy: !attach ? no('attach_disabled') : input.codexLiveQueue ? yes('app_queue') : no('codex_live_queue_off'),
      fork: fork('codex'),
      cancelDesk: desk('deskCodex'),
      // The broker takes Codex PermissionRequests; Desktop threads run approval `never`.
      approvals: input.brokerEnabled ? yes('on_request_only') : no('broker_off'),
      nativeQueue: yes(),
      keepModel: full ? yes() : no('full_permissions_off'),
      permissions: full ? yes('session_posture') : no('full_permissions_off'),
    },
    cursor: {
      // An idle IDE composer cannot take a message from outside; a CLI chat can.
      continueIdle: attach ? yes('cli_chat_only') : no('attach_disabled'),
      continueBusy: no('queued_until_turn_end'),
      fork: fork('cursor', 'new_session'),
      cancelDesk: desk('deskCursor'),
      // Cursor approvals cannot be answered remotely in `-p` (canary C3a).
      approvals: no('engine_limit'),
      nativeQueue: no('engine_limit'),
      keepModel: full ? yes() : no('full_permissions_off'),
      permissions: full ? yes('run_everything') : no('full_permissions_off'),
    },
  }
}

/** `{ claude: { act }, codex: { act }, cursor: { act } }`, ready to merge. */
export function providerActSections(input: ProviderActInput): Record<ProviderName, { act: ProviderAct }> {
  const acts = providerActs(input)
  return { claude: { act: acts.claude }, codex: { act: acts.codex }, cursor: { act: acts.cursor } }
}

/**
 * Join per-provider sections (`act` from here, `observe` from the hooks work) into ONE
 * `providers` object. Later sections add keys; they never replace a provider wholesale.
 */
export function mergeProviderSections(
  ...sections: Array<Partial<Record<string, Record<string, unknown>>> | null | undefined>
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const section of sections) {
    if (!section) continue
    for (const [provider, fields] of Object.entries(section)) {
      if (!fields || typeof fields !== 'object') continue
      out[provider] = { ...(out[provider] ?? {}), ...fields }
    }
  }
  return out
}

/**
 * The live input, read from the same flags the routes decide with. Separate from the pure
 * `providerActs` so tests drive every branch without the environment.
 */
export function liveProviderActInput(base: {
  attachEnabled: boolean
  forkProviders: readonly string[]
  sessionCancel: Record<string, unknown> | null | undefined
}): ProviderActInput {
  let brokerEnabled = false
  try {
    brokerEnabled = permissionBrokerHealthFields().permissionBroker?.enabled === true
  } catch {
    brokerEnabled = false
  }
  return {
    ...base,
    brokerEnabled,
    continueLive: continueLiveEnabled(),
    codexLiveQueue: codexLiveQueueEnabled(),
  }
}
