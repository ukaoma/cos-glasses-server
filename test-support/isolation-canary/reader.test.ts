import { it } from 'vitest'
import { checkConcurrentHome } from './check.js'

it('keeps a reader fingerprint private while another worker writes', () => checkConcurrentHome('reader', 'writer'))
