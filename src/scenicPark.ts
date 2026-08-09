// Authored placements for the external park kit. Keeping these coordinates in a pure,
// data-only module makes the art pass reviewable without opening the renderer and gives us
// one stable seam for the future stadium-to-park chunk data.
import { TRACK_OUT } from './scenic'

export interface ScenicParkPlacement {
  assetId: string
  s: number
  o: number
  scale: number
  rotation: number
}

const PLACEMENTS: readonly ScenicParkPlacement[] = [
  {
    assetId: 'kenney-tree-detailed',
    s: 52,
    o: TRACK_OUT + 8,
    scale: 3.2,
    rotation: 0.35,
  },
  {
    assetId: 'kenney-bush-detailed',
    s: 58,
    o: TRACK_OUT + 8.8,
    scale: 2.4,
    rotation: -0.5,
  },
]

export function scenicParkPlacements(): ScenicParkPlacement[] {
  return PLACEMENTS.map((placement) => ({ ...placement }))
}
