import { probeControl2Sandbox } from '../lib/control2-sandbox.js'
const result = await probeControl2Sandbox()
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.proven ? 0 : 1
