import { describe, expect, it, vi } from 'vitest'
import {
  assetsForTier,
  loadScenicManifest,
  SCENIC_ASSET_BUDGET,
  validateScenicManifest,
  type ScenicAsset,
  type ScenicAssetManifest,
} from './scenicAssets'

const asset = (overrides: Partial<ScenicAsset> = {}): ScenicAsset => ({
  id: 'park-tree',
  kind: 'environment',
  path: 'scenic/park-tree.glb',
  bytes: 120_000,
  triangles: 2400,
  tier: 'all',
  license: 'CC0-1.0',
  source: 'https://example.com/park-tree',
  attribution: 'Example artist, CC0 1.0',
  ...overrides,
})

describe('validateScenicManifest', () => {
  it('accepts a complete licensed manifest', () => {
    expect(validateScenicManifest({ version: 1, assets: [asset()] })).toEqual([])
  })

  it('rejects unlicensed, untraceable, oversized, and duplicate assets', () => {
    const bad = asset({
      bytes: SCENIC_ASSET_BUDGET.maxFileBytes + 1,
      license: 'unknown' as never,
      source: 'somewhere',
      attribution: '',
    })
    const errors = validateScenicManifest({ version: 1, assets: [bad, bad] })
    expect(errors).toContain('assets[0].bytes exceeds file budget')
    expect(errors).toContain('assets[0].license is invalid')
    expect(errors).toContain('assets[0].source must be an https URL')
    expect(errors).toContain('assets[0].attribution is required')
    expect(errors).toContain('assets[1].id is duplicated')
    expect(errors).toContain('assets[1].path is duplicated')
  })

  it('requires audio assets to report zero triangles', () => {
    expect(validateScenicManifest({ version: 1, assets: [asset({ kind: 'audio' })] })).toContain(
      'assets[0].triangles must be 0 for audio',
    )
  })
})

describe('assetsForTier', () => {
  const manifest: ScenicAssetManifest = {
    version: 1,
    assets: [
      asset(),
      asset({ id: 'better-tree', path: 'scenic/better-tree.glb', tier: 'high' }),
      asset({ id: 'hero-tree', path: 'scenic/hero-tree.glb', tier: 'ultra' }),
    ],
  }

  it('only exposes common assets on low', () => {
    expect(assetsForTier(manifest, 'low').map((entry) => entry.id)).toEqual(['park-tree'])
  })

  it('adds rather than replaces higher-tier assets', () => {
    expect(assetsForTier(manifest, 'high')).toHaveLength(2)
    expect(assetsForTier(manifest, 'ultra')).toHaveLength(3)
  })
})

describe('loadScenicManifest', () => {
  const manifest: ScenicAssetManifest = { version: 1, assets: [] }

  it('resolves below the application base path used by GitHub Pages', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      void input
      return { ok: true, status: 200, json: async () => manifest }
    })
    await expect(loadScenicManifest('https://example.com/WalkFit/', fetcher)).resolves.toEqual(
      manifest,
    )
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://example.com/WalkFit/scenic/manifest.json',
    )
  })

  it('rejects HTTP and manifest failures with useful errors', async () => {
    await expect(
      loadScenicManifest('https://example.com/WalkFit/', async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })),
    ).rejects.toThrow('scenic manifest request failed (404)')
    await expect(
      loadScenicManifest('https://example.com/WalkFit/', async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: 2, assets: [] }),
      })),
    ).rejects.toThrow('manifest.version must be 1')
  })
})
