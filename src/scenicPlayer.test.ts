import { describe, expect, it } from 'vitest'
import { AVATAR_STYLES, avatarStyleConfig, cameraViewConfig } from './scenicPlayer'

describe('cameraViewConfig', () => {
  it('keeps first person at eye height with viewmodel arms', () => {
    expect(cameraViewConfig('first')).toEqual({
      followM: 0,
      heightM: 1.6,
      lookAheadM: 10,
      targetHeightM: 1.4,
      motionScale: 1,
      showAvatar: false,
      showViewmodelArms: true,
    })
  })

  it('frames the visible player from behind and dampens camera bob', () => {
    const third = cameraViewConfig('third')
    expect(third.followM).toBeGreaterThan(0)
    expect(third.heightM).toBeGreaterThan(cameraViewConfig('first').heightM)
    expect(third.motionScale).toBeLessThan(1)
    expect(third.showAvatar).toBe(true)
    expect(third.showViewmodelArms).toBe(false)
  })
})

describe('avatar styles', () => {
  it('has stable unique ids and colours for local persistence', () => {
    expect(new Set(AVATAR_STYLES.map((style) => style.id)).size).toBe(AVATAR_STYLES.length)
    expect(new Set(AVATAR_STYLES.map((style) => style.kit)).size).toBe(AVATAR_STYLES.length)
  })

  it('resolves each supported style', () => {
    for (const style of AVATAR_STYLES) expect(avatarStyleConfig(style.id)).toEqual(style)
  })
})
