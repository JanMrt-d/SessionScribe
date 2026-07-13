import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

test('creates a lecture session and restores it after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sessionscribe-e2e-'))
  let application: ElectronApplication | null = null
  try {
    application = await launch(root)
    let window = await application.firstWindow()
    await expect(window.getByText('SessionScribe', { exact: true }).first()).toBeVisible()
    await window.getByRole('button', { name: 'New recording' }).first().click()
    await window.getByRole('button', { name: 'Lecture' }).click()
    const titleInput = window.getByLabel('Session title')
    await titleInput.fill('Distributed systems lecture')
    await expect(titleInput).toHaveValue('Distributed systems lecture')
    await window.getByRole('button', { name: 'Set up recording' }).click()
    await expect(
      window.getByText('Distributed systems lecture', { exact: true }).first()
    ).toBeVisible()
    await expect(window.getByText('OBS connection', { exact: false }).first()).toBeVisible()

    await application.close()
    application = await launch(root)
    window = await application.firstWindow()
    await expect(
      window.getByText('Distributed systems lecture', { exact: true }).first()
    ).toBeVisible()
  } finally {
    await application?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

async function launch(root: string): Promise<ElectronApplication> {
  const executablePath = process.env.SESSION_SCRIBE_E2E_EXECUTABLE
    ? resolve(process.env.SESSION_SCRIBE_E2E_EXECUTABLE)
    : undefined
  const profileArgument = `--user-data-dir=${join(root, 'user-data')}`

  return await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [profileArgument] : [resolve('out/main/index.js'), profileArgument],
    env: {
      ...process.env,
      SESSION_SCRIBE_VIDEOS_DIR: join(root, 'videos'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })
}
