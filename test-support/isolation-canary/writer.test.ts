import { it } from 'vitest'
import { checkConcurrentHome } from './check.js'

it('keeps writer cleanup away from another worker home', () => checkConcurrentHome('writer', 'reader'))
