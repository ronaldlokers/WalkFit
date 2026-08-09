import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const root = 'public/scenic'
const manifestPath = join(root, 'manifest.json')
const supported = new Set(['.glb', '.webp', '.ktx2', '.ogg'])
const licenses = new Set(['CC0-1.0', 'CC-BY-4.0', 'LicenseRef-WalkFit'])
const tiers = new Set(['all', 'high', 'ultra'])
const kinds = new Set(['character', 'environment', 'prop', 'texture', 'audio'])
const maxFile = 4 * 1024 * 1024
const maxTotal = 16 * 1024 * 1024

if (!existsSync(manifestPath)) throw new Error(`missing ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.version !== 1 || !Array.isArray(manifest.assets))
  throw new Error('invalid manifest shape')

const declared = new Set()
const ids = new Set()
let total = 0
for (const asset of manifest.assets) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(asset.id) || ids.has(asset.id))
    throw new Error(`invalid or duplicate asset id: ${asset.id}`)
  ids.add(asset.id)
  if (!licenses.has(asset.license))
    throw new Error(`${asset.id}: unsupported license ${asset.license}`)
  if (!tiers.has(asset.tier)) throw new Error(`${asset.id}: invalid tier ${asset.tier}`)
  if (!kinds.has(asset.kind)) throw new Error(`${asset.id}: invalid kind ${asset.kind}`)
  if (!/^\/scenic\/[a-z0-9/_-]+\.(?:glb|webp|ktx2|ogg)$/.test(asset.path))
    throw new Error(`${asset.id}: invalid scenic asset path ${asset.path}`)
  if (!/^https:\/\//.test(asset.source) || !asset.attribution?.trim())
    throw new Error(`${asset.id}: source and attribution are required`)
  if (!Number.isInteger(asset.triangles) || asset.triangles < 0)
    throw new Error(`${asset.id}: invalid triangle count`)
  if (asset.kind === 'audio' && asset.triangles !== 0)
    throw new Error(`${asset.id}: audio triangle count must be 0`)
  const file = join('public', asset.path)
  if (!existsSync(file)) throw new Error(`${asset.id}: missing ${file}`)
  const bytes = statSync(file).size
  if (bytes !== asset.bytes)
    throw new Error(`${asset.id}: manifest says ${asset.bytes} bytes, file is ${bytes}`)
  if (bytes > maxFile) throw new Error(`${asset.id}: ${bytes} bytes exceeds ${maxFile}`)
  total += bytes
  const relativeFile = relative(root, file)
  if (declared.has(relativeFile)) throw new Error(`${asset.id}: duplicate path ${asset.path}`)
  declared.add(relativeFile)
}
if (total > maxTotal) throw new Error(`scenic assets total ${total} bytes exceeds ${maxTotal}`)

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
const orphan = walk(root)
  .filter((file) => supported.has(extname(file)))
  .map((file) => relative(root, file))
  .filter((file) => !declared.has(file))
if (orphan.length) throw new Error(`unmanifested scenic assets: ${orphan.join(', ')}`)

console.log(
  `check-scenic-assets: ${manifest.assets.length} assets, ${(total / 1024 / 1024).toFixed(2)} MiB ✓`,
)
