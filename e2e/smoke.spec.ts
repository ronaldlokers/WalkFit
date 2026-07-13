import { test, expect } from '@playwright/test'

test('loads and shows the onboarding wizard', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Connect your treadmill' })).toBeVisible()
  // visual baseline of the first screen (generated in the Playwright container)
  await expect(page).toHaveScreenshot('wizard.png', { animations: 'disabled' })
})

test('wizard → Free walk reaches the main screen', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Skip', exact: true }).click() // treadmill step
  await page.getByRole('button', { name: 'Skip', exact: true }).click() // heart-rate step
  await page.getByRole('button', { name: 'Free walk' }).click()
  await expect(page.getByRole('heading', { name: 'Connect your treadmill' })).toBeHidden()
  // the header stat strip replaced the old stats section (#46)
  await expect(page.getByText('min/km')).toBeVisible()
})
