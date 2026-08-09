import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { type ScenicAsset, type ScenicAssetManifest } from './scenicAssets'
type Loader = Pick<GLTFLoader, 'loadAsync'>

export interface ScenicAssetInstance {
  scene: THREE.Object3D
  animations: THREE.AnimationClip[]
}

function disposeScene(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : []
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose()
      }
      material.dispose()
    }
  })
}

// One loader and one source graph per component mount. Instances are skeleton-safe clones;
// source GPU resources remain shared until dispose(), which avoids duplicate textures while
// ensuring a 2D/3D toggle releases everything deterministically.
export class ScenicAssetCache {
  private readonly entries: Map<string, ScenicAsset>
  private readonly pending = new Map<string, Promise<GLTF | null>>()

  constructor(
    manifest: ScenicAssetManifest,
    private readonly baseUrl: string,
    private readonly loader: Loader = new GLTFLoader(),
  ) {
    this.entries = new Map(manifest.assets.map((asset) => [asset.id, asset]))
  }

  async instantiate(id: string): Promise<ScenicAssetInstance | null> {
    const asset = this.entries.get(id)
    if (!asset || !asset.path.endsWith('.glb')) return null
    let request = this.pending.get(id)
    if (!request) {
      request = this.loader.loadAsync(new URL(asset.path, this.baseUrl).href).catch(() => null)
      this.pending.set(id, request)
    }
    const gltf = await request
    if (!gltf) return null
    return { scene: cloneSkeleton(gltf.scene), animations: gltf.animations }
  }

  async dispose(): Promise<void> {
    const loaded = await Promise.all(this.pending.values())
    for (const gltf of loaded) if (gltf) disposeScene(gltf.scene)
    this.pending.clear()
  }
}
