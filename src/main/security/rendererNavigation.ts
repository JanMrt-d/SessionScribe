export function isTrustedRendererLocation(
  candidate: string,
  trustedLocation: string,
  allowSameOrigin: boolean
): boolean {
  try {
    const current = new URL(candidate)
    const trusted = new URL(trustedLocation)
    if (allowSameOrigin) {
      return ['http:', 'https:'].includes(trusted.protocol) && current.origin === trusted.origin
    }
    return (
      trusted.protocol === 'file:' &&
      current.protocol === 'file:' &&
      current.host === trusted.host &&
      current.pathname === trusted.pathname &&
      current.search === trusted.search
    )
  } catch {
    return false
  }
}
