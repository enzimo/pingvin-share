# v1.14.0 security release

This Enzimo release keeps the v1.13 SQLite schema, data mounts, and upload API.
Back up the database, files, images, and config before upgrading. Pause writes
while taking the backup, and test the update on a copy first.

The image is `ghcr.io/enzimo/pingvin-share:v1.14.0`. The release workflow tests
native amd64 and arm64 images before publishing a combined manifest.

## Security fixes

- Validate all sign-in redirect destinations, addressing CVE-2026-9519.
- Await password and LDAP checks for TOTP management, addressing the original
  code's instance of the flaw described in CVE-2026-49467.
- Use millisecond rate-limit windows and restrict trusted proxies.
- Require explicit authenticated OAuth linking instead of matching accounts by
  email. New external registrations require a verified email. Verify OIDC
  signatures, issuer, audience, expiry, and nonce against the provider's JWKS.
- Enforce private reverse-share access on direct downloads and require signed
  upload-owner cookies for anonymous mutations. Protect account operations even
  when anonymous uploads are enabled.
- Scope storage lookups to both the file ID and the authorized share ID.
- Enforce reset-token expiration and single use in the password-change
  transaction, revoke existing sessions, and reject revoked access tokens.
- Use HttpOnly access cookies and serialize initial administrator creation.
- Upgrade to Next.js 16.4.2, sharp 0.35.5, current patched Nest 11 dependencies,
  and Node 24. Disable the unused image optimizer.
- Update dependency trees for the application and documentation. The documentation
  builder uses a local bounded-recursion patch for the currently unpatched
  braces package. See `vendor/braces/SECURITY-PATCH.md`.

## Configuration and compatibility

Reverse proxies must overwrite untrusted forwarded headers. When `TRUST_PROXY`
is true, set `TRUSTED_PROXIES` to the actual source IPs or CIDRs of your external
proxies, separated by spaces. The bundled Caddy connection remains trusted on
loopback. The old configuration that trusted every address is removed. Close
direct access around the proxy. Incorrect allowlists can cause rate limits to
group clients under the proxy address.

Existing linked OAuth accounts keep working. Accounts with matching email
addresses must now sign in locally and link the provider from My account.
An OIDC provider must emit `email_verified=true` for a new external registration.
Providers without that claim, including some Microsoft configurations, can still
be linked explicitly to an existing signed-in account. Confirm an administrator
login method before upgrading an OAuth-only installation.

Existing completed anonymous shares remain downloadable under their normal
access policy. They cannot be modified by presenting only their share ID.
Anonymous uploads started before the upgrade have no owner cookie and must be
restarted. New anonymous ownership cookies expire after 24 hours and cannot
modify a submitted upload.

The PWA manifest remains available. A small network-only service worker replaces
the obsolete build plugin and removes its previous Workbox caches. Offline
asset precaching is no longer provided. Original uploaded files continue to be
served as downloads; Next's native image optimization endpoint returns 404.

## Release validation

The workflow installs reproducible locks and audits all five package trees,
builds the backend, frontend, and documentation, runs security regressions using
SQLite and signed OIDC tokens, and exercises the container's real HTTP API.
It scans each architecture with Trivy and rejects reported vulnerabilities with
available fixes. Full JSON scan results, including findings without available
fixes, are preserved as workflow artifacts. A green gate is evidence for that
scan's scope and database date, not a guarantee against unknown vulnerabilities.

The earlier `security_best_practices_report.md` records the original v1.13
baseline. Its findings describe the code before this release's fixes.
