/**
 * Builds the renderer's Content-Security-Policy.
 *
 * Development loads the renderer from the Vite dev server, which injects its
 * React Fast Refresh preamble as an inline script. Component modules call the
 * globals that preamble defines at evaluation time, so blocking it does not
 * merely cost hot reload: the module graph throws before React mounts or the
 * stylesheet is applied, leaving an empty transparent page. Packaged builds
 * load local files and carry no inline script, so they keep the strict policy.
 */
export function contentSecurityPolicy(allowDevelopmentRenderer: boolean): string {
  const scriptSources = allowDevelopmentRenderer ? "'self' 'unsafe-inline'" : "'self'"
  const connectSources = allowDevelopmentRenderer
    ? "'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*"
    : "'self'"
  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' sessionscribe-media:",
    `connect-src ${connectSources}`
  ].join('; ')
}
