import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from './contentSecurityPolicy'

function directive(policy: string, name: string): string {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `))
  if (!found) throw new Error(`The policy is missing a ${name} directive`)
  return found
}

describe('contentSecurityPolicy', () => {
  it('never allows inline scripts in a packaged renderer', () => {
    const policy = contentSecurityPolicy(false)
    expect(directive(policy, 'script-src')).toBe("script-src 'self'")
    expect(policy).not.toContain('localhost')
    expect(directive(policy, 'connect-src')).toBe("connect-src 'self'")
  })

  it('allows the dev server preamble and its reload socket in development', () => {
    const policy = contentSecurityPolicy(true)
    // The React Fast Refresh preamble is inline, and component modules call the
    // globals it defines, so blocking it leaves the renderer entirely unmounted.
    expect(directive(policy, 'script-src')).toContain("'unsafe-inline'")
    expect(directive(policy, 'connect-src')).toContain('ws://127.0.0.1:*')
  })

  it('keeps the remaining directives identical across both modes', () => {
    for (const name of ['default-src', 'style-src', 'img-src', 'media-src']) {
      expect(directive(contentSecurityPolicy(true), name)).toBe(
        directive(contentSecurityPolicy(false), name)
      )
    }
    expect(directive(contentSecurityPolicy(false), 'default-src')).toBe("default-src 'self'")
    expect(directive(contentSecurityPolicy(false), 'media-src')).toBe(
      "media-src 'self' sessionscribe-media:"
    )
  })
})
