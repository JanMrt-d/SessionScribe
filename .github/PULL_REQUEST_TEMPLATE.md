## What changed

<!-- The user-visible effect, and why. Not just which files moved. -->

## Verification

<!-- Which gates you actually ran. Delete what does not apply. -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm test`
- [ ] `npm run test:integration`
- [ ] `npm run build`
- [ ] `npm run test:e2e`
- [ ] `npm run package:linux` and `npm run test:e2e:packaged:linux` (packaging, `extraResources`, or `process.resourcesPath` changes)

## Checklist

- [ ] A bug fix comes with a test that fails without the fix.
- [ ] OBS tests drive the v5 protocol fake, not mocked gateway methods.
- [ ] Provider tests use local fixture servers and need no paid credentials.
- [ ] Managed-runtime tests use fake Docker runners and need no GPU or Docker daemon.
- [ ] No transcripts, summaries, provider payloads, credentials, or OBS passwords are logged.
- [ ] The renderer receives no credentials and no unrestricted paths.

## Out of scope

<!-- Anything you deliberately left for later. -->
