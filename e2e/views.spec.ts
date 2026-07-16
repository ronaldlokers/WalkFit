import { test, expect, type Page } from '@playwright/test'

// Every view reachable without BLE hardware (#49). Data-dependent views are seeded
// through localStorage before load; no live GATT flows here — those live in the
// mocked component tests. Assertion-only: new screenshot baselines need the CI
// container to generate (no docker in the devcontainer), so this suite adds none.

const setupDone = { 'walkfit.setupDone': '1' }

async function seed(page: Page, extra: Record<string, string> = {}) {
  await page.addInitScript(
    (kv) => {
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v)
    },
    { ...setupDone, ...extra },
  )
}

function currentWeekHistory() {
  // one walk today, one yesterday — both inside the statistics week unless today is
  // Monday, in which case yesterday's lands in the previous week; keep assertions to
  // today's entry only
  const at = (daysAgo: number, h: number) => {
    const d = new Date()
    d.setDate(d.getDate() - daysAgo)
    d.setHours(h, 15, 0, 0)
    return d.toISOString()
  }
  return JSON.stringify([
    { date: at(1, 18), distance: 900, duration: 720, kcal: 41, avgHr: 101 },
    {
      date: at(0, 8),
      distance: 1500,
      duration: 1200,
      kcal: 72,
      steps: 1800,
      avgHr: 112,
      hrMin: 88,
      hrMax: 131,
    },
  ])
}

test.describe('wizard', () => {
  test('walks every step, Back works, embedded picker has both tabs', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Connect your treadmill' })).toBeVisible()
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(page.getByRole('heading', { name: /heart rate/i })).toBeVisible()
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(page.getByText(/What.*today/i)).toBeVisible()
    // step 4: the embedded workout picker, weight-loss tab default + HR tab reachable
    await page.locator('.mode-card', { hasText: 'Workout' }).click()
    await expect(page.locator('.tcard')).toHaveCount(5)
    await page.locator('.workout-tab', { hasText: 'Heart rate' }).click()
    await expect(page.locator('.hr-zone-opt')).toHaveCount(4)
    // Back returns to the mode grid, Free walk lands on the main screen
    await page.getByRole('button', { name: 'Back' }).click()
    await page.getByRole('button', { name: 'Free walk' }).click()
    await expect(page.getByRole('heading', { name: 'Connect your treadmill' })).toBeHidden()
    await expect(page.locator('.stat-strip')).toBeVisible()
  })
})

test.describe('main view', () => {
  test('immersive layout: idle stat strip, controls, view flip', async ({ page }) => {
    await seed(page)
    await page.goto('/')
    await expect(page.locator('.app')).toHaveClass(/layout-immersive/)
    await expect(page.locator('.stat-strip.idle')).toBeVisible()
    await expect(page.locator('.stat-strip')).toContainText('min/km')
    // the Morning Glass dock is Start + Stop only; Pause/Reset and the goal chips
    // are parked (deliberately display:none) until they earn a spot in the design
    for (const label of ['Start', 'Stop']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: 'Reset' })).toBeHidden()
    await expect(page.locator('.goal-row')).toBeHidden()
    await expect(page.locator('.view-flip')).toBeVisible()
    await expect(page.locator('svg.track')).toBeVisible() // 2D track default
    // header menu: no Disconnect while not connected
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(page.locator('.menu-item', { hasText: 'Settings' })).toBeVisible()
    await expect(page.locator('.menu-item', { hasText: 'Disconnect' })).toBeHidden()
  })

  test('scenic toggle and the persisted-scenic reload regression', async ({ page }) => {
    // load straight into a persisted scenic preference (guards the pathLen remount
    // regression in CLAUDE.md), then switch back to the 2D track: the runner marker
    // must exist, which requires the recomputed path geometry
    await seed(page, { 'walkfit.view': 'scenic' })
    await page.goto('/')
    // scenic mounts (three.js lazy chunk) or falls back without WebGL — either way
    // the 2D button must land us on a working track view
    await page.locator('.view-flip button', { hasText: '2D' }).click()
    await expect(page.locator('svg.track')).toBeVisible()
    await expect(page.locator('.runner')).toBeVisible()
  })
})

test.describe('workout menu', () => {
  test('plans tab lists 5 presets with stats, HR tab the 4 targets, closes', async ({ page }) => {
    await seed(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.locator('.menu-item', { hasText: 'Workout' }).click()
    await expect(page.locator('.tcard')).toHaveCount(5)
    await expect(page.locator('.tcard').first()).toContainText(/km/)
    await expect(page.locator('.tcard').first()).toContainText(/kcal/)
    await page.locator('.workout-tab', { hasText: 'Heart rate' }).click()
    await expect(page.locator('.hr-zone-opt')).toHaveCount(4)
    await page.locator('.wp-head .x').click()
    await expect(page.locator('.tcard')).toHaveCount(0)
  })
})

test.describe('statistics', () => {
  test('hero band, single-page sections, weigh-in, week navigation', async ({ page }) => {
    await seed(page, {
      'walkfit.history': currentWeekHistory(),
      'walkfit.goals': JSON.stringify({ kcal: 400, steps: 6000, minutes: 30 }),
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.locator('.menu-item', { hasText: 'Statistics' }).click()

    // hero band shows the week's numbers
    await expect(page.locator('.hero-band')).toContainText('kcal')
    await expect(page.locator('.hero-band')).toContainText('day streak')
    // Activity: three charts, full Mon-Sun axis — no tab click, single page (#178)
    await expect(page.locator('.activity-grid .card')).toHaveCount(3)
    await expect(page.locator('.activity-grid .card').first().locator('.bar-slot')).toHaveCount(7)
    // Heart rate: today's session has a range
    await expect(page.locator('.hr-span').first()).toBeVisible()
    // Walks: today's walk listed
    await expect(page.locator('.walk-row').first()).toContainText('1.50 km')
    // Weight: manual weigh-in persists
    await page.locator('.weigh-row input').fill('82.4')
    await page.getByRole('button', { name: 'Log weigh-in' }).click()
    await expect(page.locator('.weight-section')).toContainText('82.4')
    const stored = await page.evaluate(() => localStorage.getItem('walkfit.weight.log'))
    expect(JSON.parse(stored!)).toHaveLength(1)

    // week navigation: back changes the label, This week returns
    const label = await page.locator('.week-label span').innerText()
    await page.locator('[title="Previous week"]').click()
    await expect(page.locator('.week-label span')).not.toHaveText(label)
    await page.getByRole('button', { name: 'This week' }).click()
    await expect(page.locator('.week-label span')).toHaveText(label)
    // back button leaves the dashboard
    await page.locator('.stats-topbar > .x').first().click()
    await expect(page.locator('.hero-band')).toBeHidden()
  })

  test('empty state without any walks', async ({ page }) => {
    await seed(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.locator('.menu-item', { hasText: 'Statistics' }).click()
    await expect(page.getByText('No walks logged yet')).toBeVisible()
  })
})

test.describe('settings', () => {
  test('edits persist to localStorage', async ({ page }) => {
    await seed(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.locator('.menu-item', { hasText: 'Settings' }).click()
    const maxHr = page.locator('input[min="120"][max="220"]')
    await maxHr.fill('185')
    await maxHr.dispatchEvent('change')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('walkfit.maxhr'))).toBe('185')
    await page.getByRole('button', { name: 'Goals' }).click() // daily goals live on their own tab (#178)
    const goalKcal = page.locator('input[min="50"][max="5000"]')
    await goalKcal.fill('600')
    await goalKcal.dispatchEvent('change')
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem('walkfit.goals') || '{}').kcal),
      )
      .toBe(600)
  })
})
