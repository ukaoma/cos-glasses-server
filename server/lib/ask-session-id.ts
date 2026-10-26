// Which recordings may open live Ask, its history and Work evidence. 6.73.8: a Mac capture
// (mac_<uuid>, lib/mac-recording.ts MAC_CAPTURE_ID) uses the same Ask as a G2 meeting; before this
// every Mac request and saved-question read failed with invalid_session_id.
// Future iPhone microphone captures share this store under their own phone_ IDs.
export const MAC_ASK_SESSION = /^mac_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const ASK_SESSION = /^(?:meeting_[A-Za-z0-9_-]{1,89}|(?:mac_|phone_(?:[0-9]{13}_)?)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
