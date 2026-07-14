// Bundle-size guard (#65): three.js is deliberately isolated in the lazy Scenic3D
// chunk. An accidental static `import * as THREE` from App.vue would silently pull
// ~500 kB into the main bundle — fail the build instead.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LIMIT_KB = 250 // main bundle is ~130 kB today; three.js would blow well past this
const dir = 'dist/assets'
const main = readdirSync(dir).find((f) => /^index-.*\.js$/.test(f))
if (!main) {
  console.error('check-bundle-size: no dist/assets/index-*.js — run `npm run build` first')
  process.exit(1)
}
const kb = statSync(join(dir, main)).size / 1024
if (kb > LIMIT_KB) {
  console.error(
    `check-bundle-size: main bundle ${main} is ${kb.toFixed(1)} kB (limit ${LIMIT_KB} kB).\n` +
      'Did something import three.js (or another heavy dep) statically? ' +
      'Scenic3D must stay a lazy defineAsyncComponent chunk.',
  )
  process.exit(1)
}
console.log(`check-bundle-size: ${main} ${kb.toFixed(1)} kB <= ${LIMIT_KB} kB ✓`)
