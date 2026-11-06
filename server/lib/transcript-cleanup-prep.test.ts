// 6.99.19: Prep copies in a meeting's files (notes and documents written before the call) are not the room's
// vocabulary, like pasted text and read pages, so saved-transcript cleanup never takes words from them.
import { describe, expect, it } from 'vitest'
import { cleanupVocabularyFiles } from './transcript-cleanup.js'
import { isPastedFileId } from './meeting-ask-store.js'
import { prepAdoptedFileId, prepSteerFileId } from '../../shared/prep.js'

const DRAFT = 'prep_' + 'a'.repeat(26)
const row = (id: string, status = 'ready') => ({ id, name: id, status, text: `words of ${id}` })

describe('cleanup vocabulary files', () => {
  it('leaves out Prep copies, pasted text and read pages; keeps the files dropped on the meeting', () => {
    const files = [row('control_file_1'), row('phone_m_000000000000000000000001'), row(prepSteerFileId(DRAFT)), row(prepAdoptedFileId(DRAFT, 'pf_0123456789abcdef')), row('paste_0123456789abcdef'), row('web_0123456789abcdef'), row('control_file_2', 'removed')]
    expect(cleanupVocabularyFiles(files, isPastedFileId).map(f => f.name)).toEqual(['control_file_1', 'phone_m_000000000000000000000001'])
  })
})
