// Telegram notifier — sends session activity via Telegram bot
// Reads config from COS scripts .telegram_config.json
// Provides both security alerts (session start/end) and conversation logging

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COS_SCRIPTS_DIR } from './python-bridge.js'

interface TelegramConfig {
  bot_token: string
  chat_id: number
}

let config: TelegramConfig | null = null

export function telegramNotificationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_TELEGRAM_NOTIFICATIONS === '1'
}

function loadConfig(): TelegramConfig | null {
  // A credential file is not consent to export conversation activity. Require
  // the same kind of explicit opt-in used by cloud transcription fallback.
  if (!telegramNotificationsEnabled()) return null
  if (config) return config
  if (!COS_SCRIPTS_DIR) return null

  try {
    const raw = readFileSync(resolve(COS_SCRIPTS_DIR, '.telegram_config.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed.bot_token && parsed.chat_id) {
      config = { bot_token: parsed.bot_token, chat_id: parsed.chat_id }
      return config
    }
  } catch { /* config not available */ }

  return null
}

async function sendTelegram(text: string): Promise<void> {
  const cfg = loadConfig()
  if (!cfg) return

  try {
    await fetch(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chat_id,
        text,
        parse_mode: 'HTML',
        disable_notification: true,
      }),
    })
  } catch {
    // Silently fail — don't break the glasses experience for a notification
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '...'
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function notifySessionStart(sessionId: string, firstQuery: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const msg = `🟢 <b>COS Glasses session started</b>\n` +
    `Session: <code>${sessionId}</code>\n` +
    `Time: ${time}\n\n` +
    `<b>First query:</b>\n${escapeHtml(truncate(firstQuery, 200))}`
  sendTelegram(msg)
}

export function notifySessionEnd(sessionId: string, exchangeCount: number, durationMin: number): void {
  const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const msg = `🔴 <b>COS Glasses session ended</b>\n` +
    `Session: <code>${sessionId}</code>\n` +
    `Time: ${time}\n` +
    `Exchanges: ${exchangeCount} messages\n` +
    `Duration: ${durationMin}m`
  sendTelegram(msg)
}

export function notifyExchange(sessionId: string, query: string, response: string): void {
  const msg = `👓 <b>${escapeHtml(truncate(query, 100))}</b>\n\n` +
    `${escapeHtml(truncate(response, 500))}\n\n` +
    `<i>Session ${sessionId}</i>`
  sendTelegram(msg)
}
