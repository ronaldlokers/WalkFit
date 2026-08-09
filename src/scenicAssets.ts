// Scenic v3 asset policy. Pure and browser-free so manifests can be validated in tests;
// the Three.js loader remains inside the lazy Scenic3D boundary.

export type ScenicAssetTier = 'all' | 'high' | 'ultra'
export type ScenicAssetKind = 'character' | 'environment' | 'prop' | 'texture' | 'audio'
export type ScenicAssetLicense = 'CC0-1.0' | 'CC-BY-4.0' | 'LicenseRef-WalkFit'

export interface ScenicAsset {
  id: string
  kind: ScenicAssetKind
  path: string
  bytes: number
  triangles: number
  tier: ScenicAssetTier
  license: ScenicAssetLicense
  source: string
  attribution: string
}

export interface ScenicAssetManifest {
  version: 1
  assets: ScenicAsset[]
}

type Fetcher = (input: string | URL) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

export async function loadScenicManifest(
  baseUrl: string,
  fetcher: Fetcher = fetch,
): Promise<ScenicAssetManifest> {
  const response = await fetcher(new URL('scenic/manifest.json', baseUrl))
  if (!response.ok) throw new Error(`scenic manifest request failed (${response.status})`)
  const value: unknown = await response.json()
  const errors = validateScenicManifest(value)
  if (errors.length) throw new Error(`invalid scenic manifest: ${errors.join('; ')}`)
  return value as ScenicAssetManifest
}

export const SCENIC_ASSET_BUDGET = {
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  visibleTriangles: { low: 80_000, high: 180_000, ultra: 350_000 },
} as const

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FILE = /^scenic\/[a-z0-9/_-]+\.(?:glb|webp|ktx2|ogg)$/
const KINDS = new Set<ScenicAssetKind>(['character', 'environment', 'prop', 'texture', 'audio'])
const TIERS = new Set<ScenicAssetTier>(['all', 'high', 'ultra'])
const LICENSES = new Set<ScenicAssetLicense>(['CC0-1.0', 'CC-BY-4.0', 'LicenseRef-WalkFit'])

export function validateScenicManifest(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['manifest must be an object']
  const manifest = value as Partial<ScenicAssetManifest>
  if (manifest.version !== 1) return ['manifest.version must be 1']
  if (!Array.isArray(manifest.assets)) return ['manifest.assets must be an array']

  const errors: string[] = []
  const ids = new Set<string>()
  const paths = new Set<string>()
  let total = 0
  manifest.assets.forEach((raw, index) => {
    const asset = raw as Partial<ScenicAsset>
    const at = `assets[${index}]`
    if (typeof asset.id !== 'string' || !ID.test(asset.id)) errors.push(`${at}.id is invalid`)
    else if (ids.has(asset.id)) errors.push(`${at}.id is duplicated`)
    else ids.add(asset.id)
    if (typeof asset.path !== 'string' || !FILE.test(asset.path))
      errors.push(`${at}.path must be a supported scenic/ asset`)
    else if (paths.has(asset.path)) errors.push(`${at}.path is duplicated`)
    else paths.add(asset.path)
    if (!KINDS.has(asset.kind as ScenicAssetKind)) errors.push(`${at}.kind is invalid`)
    if (!TIERS.has(asset.tier as ScenicAssetTier)) errors.push(`${at}.tier is invalid`)
    if (!LICENSES.has(asset.license as ScenicAssetLicense)) errors.push(`${at}.license is invalid`)
    if (typeof asset.source !== 'string' || !/^https:\/\//.test(asset.source))
      errors.push(`${at}.source must be an https URL`)
    if (typeof asset.attribution !== 'string' || !asset.attribution.trim())
      errors.push(`${at}.attribution is required`)
    if (!Number.isInteger(asset.bytes) || (asset.bytes ?? 0) <= 0)
      errors.push(`${at}.bytes must be a positive integer`)
    else {
      total += asset.bytes!
      if (asset.bytes! > SCENIC_ASSET_BUDGET.maxFileBytes)
        errors.push(`${at}.bytes exceeds file budget`)
    }
    if (!Number.isInteger(asset.triangles) || (asset.triangles ?? -1) < 0)
      errors.push(`${at}.triangles must be a non-negative integer`)
    if (asset.kind === 'audio' && asset.triangles !== 0)
      errors.push(`${at}.triangles must be 0 for audio`)
  })
  if (total > SCENIC_ASSET_BUDGET.maxTotalBytes) errors.push('manifest exceeds total byte budget')
  return errors
}

export function assetsForTier(
  manifest: ScenicAssetManifest,
  tier: 'low' | 'high' | 'ultra',
): ScenicAsset[] {
  const allowed =
    tier === 'low' ? ['all'] : tier === 'high' ? ['all', 'high'] : ['all', 'high', 'ultra']
  return manifest.assets.filter((asset) => allowed.includes(asset.tier))
}
