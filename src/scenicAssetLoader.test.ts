import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { ScenicAssetCache } from './scenicAssetLoader'
import type { ScenicAssetManifest } from './scenicAssets'

const manifest: ScenicAssetManifest = {
  version: 1,
  assets: [
    {
      id: 'park-tree',
      kind: 'environment',
      path: 'scenic/park-tree.glb',
      bytes: 100,
      triangles: 12,
      tier: 'all',
      license: 'CC0-1.0',
      source: 'https://example.com/tree',
      attribution: 'Example, CC0',
    },
  ],
}

describe('ScenicAssetCache', () => {
  it('deduplicates downloads but returns independent scene graphs', async () => {
    const source = new THREE.Group()
    source.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
    const loadAsync = vi.fn(async () => ({ scene: source, animations: [] }))
    const cache = new ScenicAssetCache(manifest, 'https://example.com/WalkFit/', {
      loadAsync,
    } as unknown as Pick<GLTFLoader, 'loadAsync'>)
    const [a, b] = await Promise.all([
      cache.instantiate('park-tree'),
      cache.instantiate('park-tree'),
    ])
    expect(loadAsync).toHaveBeenCalledOnce()
    expect(loadAsync).toHaveBeenCalledWith('https://example.com/WalkFit/scenic/park-tree.glb')
    expect(a?.scene).not.toBe(b?.scene)
    await cache.dispose()
  })

  it('returns null for missing, non-model, and failed assets', async () => {
    const loadAsync = vi.fn(async () => {
      throw new Error('broken GLB')
    })
    const cache = new ScenicAssetCache(manifest, 'https://example.com/WalkFit/', {
      loadAsync,
    } as unknown as Pick<GLTFLoader, 'loadAsync'>)
    await expect(cache.instantiate('missing')).resolves.toBeNull()
    await expect(cache.instantiate('park-tree')).resolves.toBeNull()
    await cache.dispose()
  })
})
