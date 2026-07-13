import { describe, expect, it } from 'vitest'
import { isTrustedRendererLocation } from '@main/security/rendererNavigation'

describe('renderer navigation policy', () => {
  it('allows only the packaged renderer file while ignoring its hash', () => {
    const trusted = 'file:///opt/SessionScribe/resources/app.asar/out/renderer/index.html'

    expect(isTrustedRendererLocation(`${trusted}#summary`, trusted, false)).toBe(true)
    expect(
      isTrustedRendererLocation(
        'file:///opt/SessionScribe/resources/app.asar/out/renderer/other.html',
        trusted,
        false
      )
    ).toBe(false)
    expect(isTrustedRendererLocation('file:///tmp/index.html', trusted, false)).toBe(false)
  })

  it('compares development URLs by parsed origin rather than string prefix', () => {
    const trusted = 'http://127.0.0.1:5173/'

    expect(isTrustedRendererLocation('http://127.0.0.1:5173/session/1', trusted, true)).toBe(true)
    expect(isTrustedRendererLocation('http://127.0.0.1:5173.evil.test/', trusted, true)).toBe(false)
    expect(isTrustedRendererLocation('https://127.0.0.1:5173/', trusted, true)).toBe(false)
  })
})
