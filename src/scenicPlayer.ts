// Pure Scenic v3 player choices shared by the settings UI and lazy Three.js renderer.
// Keep this module independent from scenic.ts: Settings imports the outfit list at runtime,
// and pulling the whole world model into the main bundle for four labels would be wasteful.

export type CameraView = 'first' | 'third'
export type AvatarStyle = 'sky' | 'coral' | 'lime' | 'violet'

export interface AvatarStyleConfig {
  id: AvatarStyle
  kit: number
}

export const AVATAR_STYLES: readonly AvatarStyleConfig[] = [
  { id: 'sky', kit: 0x5aa7e8 },
  { id: 'coral', kit: 0xe76f51 },
  { id: 'lime', kit: 0x62b44b },
  { id: 'violet', kit: 0x8b6fd6 },
]

export function avatarStyleConfig(style: AvatarStyle): AvatarStyleConfig {
  return AVATAR_STYLES.find((entry) => entry.id === style) ?? AVATAR_STYLES[0]!
}

export interface CameraViewConfig {
  followM: number
  heightM: number
  lookAheadM: number
  targetHeightM: number
  motionScale: number
  showAvatar: boolean
  showViewmodelArms: boolean
}

const CAMERA_VIEWS: Record<CameraView, CameraViewConfig> = {
  first: {
    followM: 0,
    heightM: 1.6,
    lookAheadM: 10,
    targetHeightM: 1.4,
    motionScale: 1,
    showAvatar: false,
    showViewmodelArms: true,
  },
  third: {
    followM: 4.5,
    heightM: 2.8,
    lookAheadM: 2,
    targetHeightM: 1.15,
    motionScale: 0.2,
    showAvatar: true,
    showViewmodelArms: false,
  },
}

export function cameraViewConfig(view: CameraView): CameraViewConfig {
  return CAMERA_VIEWS[view]
}
