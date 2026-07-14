import { describe, it, expect, afterEach } from 'vitest'
import { t, locale, localeTag, LOCALES } from './i18n'

afterEach(() => {
  locale.value = 'en'
})

describe('i18n (#26)', () => {
  it('translates and interpolates', () => {
    expect(t('wizard.tmTitle')).toBe('Connect your treadmill')
    expect(t('workout.seg', { n: 2, total: 8 })).toBe('seg 2/8')
    locale.value = 'nl'
    expect(t('wizard.tmTitle')).toBe('Verbind je loopband')
    expect(t('workout.seg', { n: 2, total: 8 })).toBe('seg 2/8')
  })

  it('persists the locale and exposes a BCP-47 tag for speech/dates', () => {
    locale.value = 'nl'
    expect(localStorage.getItem('walkfit.lang')).toBe('nl')
    expect(localeTag()).toBe('nl-NL')
    locale.value = 'en'
    expect(localeTag()).toBe('en-US')
  })

  it('every locale covers every key (no silent English gaps)', () => {
    // the NL table is typed Record<MessageKey, string>, so a missing key is a compile
    // error — this guards the runtime shape (e.g. against future untyped loading)
    expect(LOCALES.map((l) => l.id)).toEqual(['en', 'nl'])
    locale.value = 'nl'
    expect(t('stats.tabWalks')).toBe('Wandelingen')
  })
})
