import { describe, expect, it } from 'vitest'
import { telegramNotificationsEnabled } from './telegram-notify.js'

describe('Telegram notification consent', () => {
  it('is disabled unless the exact opt-in is present', () => {
    expect(telegramNotificationsEnabled({})).toBe(false)
    expect(telegramNotificationsEnabled({ COS_TELEGRAM_NOTIFICATIONS: '0' })).toBe(false)
    expect(telegramNotificationsEnabled({ COS_TELEGRAM_NOTIFICATIONS: 'true' })).toBe(false)
    expect(telegramNotificationsEnabled({ COS_TELEGRAM_NOTIFICATIONS: '1' })).toBe(true)
  })
})
