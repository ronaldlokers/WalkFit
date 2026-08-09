import { describe, expect, it } from 'vitest'
import { AVATAR_STYLES, avatarStyleConfig, cameraViewConfig, playerGait } from './scenicPlayer'

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

describe('playerGait', () => {
  it('stays idle unless the treadmill is actively moving', () => {
    expect(playerGait(false, 5)).toEqual({ state: 'idle', legSwing: 0, armSwing: 0 })
    expect(playerGait(true, 0)).toEqual({ state: 'idle', legSwing: 0, armSwing: 0 })
  })

  it('selects increasingly expressive walk, brisk, and jog poses', () => {
    const walk = playerGait(true, 3)
    const brisk = playerGait(true, 4.5)
    const jog = playerGait(true, 6)
    expect([walk.state, brisk.state, jog.state]).toEqual(['walk', 'brisk', 'jog'])
    expect(walk.legSwing).toBeLessThan(brisk.legSwing)
    expect(brisk.legSwing).toBeLessThan(jog.legSwing)
    expect(walk.armSwing).toBeLessThan(brisk.armSwing)
    expect(brisk.armSwing).toBeLessThan(jog.armSwing)
  })

  it('treats invalid speed as stopped', () => {
    expect(playerGait(true, Number.NaN).state).toBe('idle')
  })
})
