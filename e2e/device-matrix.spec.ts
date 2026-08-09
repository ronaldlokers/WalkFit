import { test, expect, type Page } from '@playwright/test'

async function seed(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('walkfit.setupDone', '1')
    localStorage.setItem('walkfit.view', 'scenic')
  })
}

async function openScenic(page: Page) {
  const scenicView = page.getByTestId('route-hud')
  if (await scenicView.isVisible().catch(() => false)) return true
  const scenic = page.getByRole('button', { name: '3D' })
  if (!(await scenic.isEnabled())) return false
  await scenic.click()
  return true
}

test.describe('narrow Scenic device profiles', () => {
  test('keeps safety controls and the scenic fallback reachable', async ({ page }) => {
    await seed(page)
    await page.goto('/')

    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
    if (await openScenic(page)) {
      await expect(page.locator('.route-hud, svg.track')).toBeVisible()
    } else {
      await expect(page.locator('svg.track')).toBeVisible()
    }
  })

  test('keeps route selection available when Scenic WebGL mounts', async ({ page }) => {
    await seed(page)
    await page.goto('/')
    test.skip(!(await openScenic(page)), 'profile has no WebGL support')
    await expect(page.getByTestId('route-hud')).toBeVisible()
    await page.getByLabel('Route').selectOption('hill-gardens')
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('walkfit.scenic.route')))
      .toBe('hill-gardens')
  })
})
