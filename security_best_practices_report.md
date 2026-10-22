> Historical baseline: this report covers the original v1.13 code before the
> Enzimo v1.14.0 fixes. See RELEASE_NOTES.md for remediation and validation.

# Security review of Pingvin Share v1.13

Reviewed on 2026-10-22. Verdict: remediate before continuing unchanged public operation.

## Executive summary

Yes, this release is out of date and contains security flaws that need fixing. The most important confirmed issues are an unsafe sign-in redirect, skipped password checks when configuring two-factor authentication, and ineffective authentication rate limits. OAuth and private reverse-share configurations introduce additional account and file-access risks.

You reported `stonith404/pingvin-share:v1.13` behind a reverse proxy. I queried Docker Hub's registry and verified that this tag currently identifies v1.13.0, built on 2025-05-25 from commit `dd546b4f17a516ef696ea35b96bbac8ff5521e2a`. The image index digest is `sha256:6bf2bcd3043ee68cb61264f0857511ccf7f212fdb984382b7f2d491635184ad6`. Your running container's digest still needs comparing with this registry result.

The checkout is `d5906ad`. The backend, dependency locks, deployment files, and relevant frontend authentication files match the v1.13.0 release commit. The original maintainer [states that maintenance ended in June 2025 and recommends the fork](https://github.com/stonith404/pingvin-share#readme). Pulling the original image again does not provide the application fixes described below.

This review did not contact your public instance, change application code, or change your deployment. It does not establish whether anyone has exploited these issues.

## Evidence and scope

I reviewed dependency locks, image metadata, Docker startup, Caddy configuration, authentication, OAuth/OIDC, upload/download authorization, password resets, and storage deletion. I used the existing-codebase review guide and a separate reviewer/critic pass to challenge each finding.

Production-dependency audits using `npm audit --omit=dev --package-lock-only --json` reported:

- Backend: 46 affected package entries, comprising 2 critical, 14 high, 28 moderate, and 2 low.
- Frontend: 28 affected package entries, comprising 1 critical, 20 high, 5 moderate, and 2 low.

These are dependency-graph counts, including propagated findings. They are neither unique CVE counts nor counts of demonstrated remote exploits. Direct advisory checks also found vulnerable Multer versions that were absent from these audit responses.

Eight local behavioral checks executed the checked-out application methods after TypeScript transpilation, with database, identity-provider, and storage test doubles. The checks also exercised the locked versions of Express and Nest's throttler. These checks verify application decisions and library behavior; they are not full HTTP, database, or production exploit tests. All eight passed. Temporary tooling and evidence are under `/tmp/pingvin-security-check` and `/tmp/pingvin-advisories`; raw audits are `/tmp/pingvin-backend-audit.json` and `/tmp/pingvin-frontend-audit.json`.

Several advisories below were published for Pingvin Share X. I independently matched their underlying flaws to this original repository. This is a source-based applicability assessment, not a claim that the advisory's formal product metadata names the original project.

## Confirmed application findings

### 1. Critical, conditional: OAuth email linking can take over an existing account

**Location:** `backend/src/oauth/oauth.service.ts:144`, especially lines 158-174; `backend/src/oauth/provider/genericOidc.provider.ts:121` and `:195`; `backend/src/auth/auth.service.ts:123`; `backend/prisma/seed/config.seed.ts:221`.

**Trigger and impact:** An enabled identity provider lets an attacker assert a victim's email without proving ownership, and `oauth.allowRegistration` is enabled. The OIDC handler accepts the email without checking `email_verified`; OAuth sign-up then links the new provider identity to the existing local account by email. An attacker can obtain access as the victim, including an administrator. Local TOTP is bypassed when `oauth.ignoreTotp` is enabled, which is the seeded default. With that setting disabled, existing verified TOTP still provides an additional gate.

**Confidence:** Verified locally. An identity with `email_verified=false` was accepted and linked to the matching synthetic victim account. Production exposure depends on your enabled provider and its email policy.

**Fix:** Require verified email claims and explicit authenticated account linking. Until fixed, disable OAuth self-registration using `oauth.allowRegistration=false`, or disable the affected provider after confirming an alternate administrator login. Disabling ordinary `share.allowRegistration` does not close this path.

Source: [GHSA-wrcg-4874-45p7](https://github.com/smp46/pingvin-share-x/security/advisories/GHSA-wrcg-4874-45p7), fixed in the fork's v1.22.0.

### 2. High: sign-in auto-redirect matches CVE-2026-9519

**Location:** `frontend/src/pages/auth/signIn.tsx:10` and `:25`; `backend/src/auth/auth.service.ts:337`.

**Trigger and impact:** A victim with a valid or refreshable session reaches `/auth/signIn` with an attacker-controlled `redirect` parameter. The page passes it directly to `router.replace`. A `javascript:` destination reaches a script-capable navigation sink. This allows script execution with the victim's application permissions. The access-token cookie is JavaScript-readable, increasing the consequence of XSS.

**Confidence:** Verified that the actual component passes the unsafe scheme unchanged. The [Next.js 14.2.26 router implementation](https://github.com/vercel/next.js/blob/v14.2.26/packages/next/src/shared/lib/router/router.ts#L1129) forwards nonlocal destinations to `window.location.href`. A production browser exploit was not run. Middleware can redirect an already-valid access token away from the sign-in page, but an expired access token with a working refresh token can reach the vulnerable flow. The ordinary login form uses a redirect helper; the auto-redirect path omits it.

**Fix:** Validate the destination before every redirect. Accept only an approved same-origin path and reject schemes, protocol-relative URLs, and malformed or repeated parameters. Review the existing helper too, since accepting every string starting with `/` is insufficient to reject protocol-relative destinations.

Sources: [official CVE record](https://github.com/CVEProject/cvelistV5/blob/main/cves/2026/9xxx/CVE-2026-9519.json) and [researcher's disclosure](https://gist.github.com/TrebledJ/0efceef4f3a2e0515cc2fe96b4c22679). The CNA rates this CVE medium; this review assigns high remediation priority because of the authenticated browser impact.

### 3. High: TOTP management skips password verification

**Location:** `backend/src/auth/authTotp.service.ts:67`, `:109`, and `:138`; `backend/src/auth/auth.service.ts:376`; authenticated routes at `backend/src/auth/auth.controller.ts:196`.

**Trigger and impact:** An attacker already has a user's session, while that account has no verified TOTP enrollment. The enable and verify methods test an unawaited Promise, so even an incorrect password passes. An attacker can enroll their own authenticator and lock the victim out. Disabling an existing authenticator still requires its code; this is not a password-only bypass of an already-enrolled second factor.

**Confidence:** Verified locally with `verifyPassword` resolving to `false`; both enable and verify still completed. The LDAP branch also converts an unawaited authentication Promise into `true`.

**Fix:** Await all password and LDAP checks. If patching is delayed, restricting the TOTP management endpoints at the proxy can prevent enrollment changes, but will also prevent legitimate configuration changes.

Source: [CVE-2026-49467 / GHSA-59q6-jvp6-w282](https://github.com/smp46/pingvin-share-x/security/advisories/GHSA-59q6-jvp6-w282), fixed in the fork's v1.18.1.

### 4. High: login rate limits use milliseconds as though they were seconds

**Location:** `backend/src/auth/auth.controller.ts:65`, `:91`, and reset-password decorators; `backend/src/app.module.ts:31`; `backend/src/main.ts:59`; `backend/package-lock.json:2996`; `reverse-proxy/Caddyfile.trust-proxy:4`.

**Trigger and impact:** Public requests reach login, TOTP, or password-reset endpoints. The configured five-minute limit is `ttl: 5 * 60`, but the locked `@nestjs/throttler` 6.4.0 interprets that as 300 milliseconds. The global `ttl: 60` means 60 milliseconds. Credential and second-factor guessing receive far less protection than intended.

There is a separate header-spoofing issue if your proxy preserves attacker-supplied forwarded IPs. Express unconditionally trusts all proxies. `TRUST_PROXY=false` changes the selected Caddy configuration, but does not change this Express setting.

**Confidence:** Verified against throttler 6.4.0: after 20 hits and a 400-millisecond pause, the next request had a hit count of one. Express also accepted a synthetic forwarded IP. Header spoofing through your particular proxy remains unverified; the TTL problem exists even if your proxy sanitizes headers correctly.

**Fix:** Express durations in milliseconds and configure trust for the actual proxy chain. Immediately add independent rate limits at your reverse proxy and overwrite incoming forwarded-IP headers using the trusted client address. Ensure the backend and container ports cannot be reached around that proxy.

Source: [GHSA-7gx2-g6x2-7mjg](https://github.com/smp46/pingvin-share-x/security/advisories/GHSA-7gx2-g6x2-7mjg), fixed in the fork's v1.22.0.

### 5. High, conditional: private reverse-share files bypass privacy checks

**Location:** `backend/src/file/guard/fileSecurity.guard.ts:36`; `backend/src/share/guard/shareOwner.guard.ts:44`; `backend/src/file/file.controller.ts:67` and `:97`.

**Trigger and impact:** An attacker knows the share and file IDs of an unexpired private reverse-share upload without a separate password or exhausted view limit. Tokenless direct downloads check expiration and password/view restrictions, but omit `reverseShare.publicAccess`. Files marked private can therefore be downloaded without the intended owner check. Any signed-in account can also pass the owner guard for a share with `creatorId=null`; anonymous metadata/deletion access additionally depends on anonymous sharing being enabled. Knowing the IDs is a prerequisite, not proof that they can be guessed.

**Confidence:** Verified that the actual file guard admits a tokenless request for a synthetic private reverse share without reaching the parent privacy check.

**Fix:** Apply private reverse-share authorization to every metadata, download, and mutation route. Until fixed, avoid using this version's private reverse shares for sensitive files, or restrict access to those resources at the proxy. Merely disabling anonymous uploads does not fix the direct-download branch.

Source: [GHSA-wx6v-vp7h-mm3g](https://github.com/smp46/pingvin-share-x/security/advisories/GHSA-wx6v-vp7h-mm3g).

### 6. High: expired password-reset tokens remain redeemable

**Location:** `backend/src/auth/auth.service.ts:175`; `backend/src/jobs/jobs.service.ts:118`.

**Trigger and impact:** An attacker obtains a reset token whose intended one-hour lifetime has elapsed but which has not yet been removed by the hourly cleanup. Redemption queries only the token string. The attacker can still change the password, potentially taking over an account without another factor. Exposure can extend by almost another hour during normal scheduling, or longer if cleanup fails.

**Confidence:** Verified that the actual reset method changes the password when the backing store retains an expired token. Possession of a reset token is required.

**Fix:** Require `expiresAt > now` in the redemption query and consume the token atomically. Cleanup is maintenance, not the expiration check.

Source: [GHSA-253c-mhf8-98fw](https://github.com/smp46/pingvin-share-x/security/advisories/GHSA-253c-mhf8-98fw). Its patched-version field and prose disagree; choose a release containing the fix rather than relying on the minimum version label alone.

### 7. Medium, S3 only: deletion can remove another share's file record

**Location:** `backend/src/file/file.controller.ts:97`; `backend/src/file/s3.service.ts:198`.

**Trigger and impact:** An attacker authorized for one share supplies another share's known file ID in a deletion request. S3 metadata lookup is global by file ID. Deleting the constructed, usually nonexistent S3 key succeeds, after which the victim's database file record is deleted. This removes application access to the victim's file; it does not establish deletion of the victim's actual S3 object.

**Confidence:** Verified with the actual S3 removal method and a successful no-op storage deletion. Local storage follows a different sequence and was not shown to have this failure.

**Fix:** Scope every file lookup to both file ID and authorized share ID before storage or database operations. Review downloads for the same missing association check.

Source: [GHSA-c4rq-cg75-9xh3](https://github.com/smp46/pingvin-share-x/security/advisories/GHSA-c4rq-cg75-9xh3), fixed in the fork's v1.22.4.

## Dependency findings requiring runtime qualification

### 8. Critical advisory: image processing needs patching or isolation

**Location:** `frontend/package-lock.json:7122` pins Next.js 14.2.26, and `:8313` pins sharp 0.33.5. `frontend/next.config.js:17` does not disable image optimization. Caddy forwards non-API paths to Next. Backend sharp 0.34.1 is pinned at `backend/package-lock.json:9640`.

The [Next.js image-optimizer advisory GHSA-2xp9-vwfh-vxw4](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4) rates AVIF processing as critical and lists these Next versions as affected. Its framework mitigation begins at 15.5.24 or 16.3.3. The [sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c) identifies libheif fixes in sharp 0.35.4 and references CVE-2026-84383.

**Impact and uncertainty:** The locked versions are affected. An attacker must get crafted image content processed by the optimizer for that attack path. Local API file URLs are a path to assess when uploads and public downloads are possible. Successful RCE was not reproduced. The upstream sharp advisory specifies glibc-related RCE conditions, while this image uses Alpine/musl, so I do not claim a confirmed RCE against your container.

There is also [CVE-2026-27980](https://github.com/vercel/next.js/security/advisories/GHSA-3x4c-7xq6-9pq8): image variants can fill the unbounded optimizer disk cache. This is relevant to self-hosting and does not require proving RCE.

**Direction:** Upgrade to a supported, currently patched Next release and patched native image libraries, rebuild, and rescan. While that work is pending, deny `/_next/image` at your reverse proxy if you do not need it. This blocks image optimization and can affect any optimized-image rendering. The checked-out frontend has no direct `next/image` imports. Apply equivalent restrictions on every route to the frontend so the proxy cannot be bypassed.

### Other affected packages and lower-priority paths

- **Multer 1.4.5-lts.2:** Within affected ranges for several DoS CVEs, including [CVE-2025-47935](https://github.com/expressjs/multer/security/advisories/GHSA-44fp-w29j-9vj5) and [CVE-2026-5079](https://github.com/expressjs/multer/security/advisories/GHSA-72gw-mp4g-v24j). In this application, the multipart interceptor is on the administrator-only logo route at `backend/src/config/config.controller.ts:62`; ordinary file uploads use a raw-body path. Treat this as patch work, not a demonstrated anonymous upload exploit. Current newer Multer advisories mean upgrading only to 2.0.0 would be insufficient.
- **fast-xml-parser 4.4.1:** Affected by [CVE-2026-25896](https://github.com/advisories/GHSA-m7jm-9gc2-mpf2) and entity-expansion DoS advisories. It arrives through the AWS SDK. I did not establish an attacker-controlled XML-to-HTML path in this service. Update the AWS SDK and its parser dependencies without presenting its critical scanner label as a confirmed public XSS.
- **Nodemailer 6.10.1:** Affected by [CVE-2025-14874](https://github.com/nodemailer/nodemailer/security/advisories/GHSA-rcmh-qjqh-p98v) and later advisories. `backend/src/email/email.service.ts:37` sends recipient strings to the library. Public exploitability depends on the configured mail features and their input validation. Update to a currently patched release and retain strict address validation.

## Findings excluded or narrowed during the critic pass

- **CVE-2025-22137, original Pingvin arbitrary file overwrite:** Fixed in 1.4.0; [the original advisory](https://github.com/stonith404/pingvin-share/security/advisories/GHSA-rjwx-p44f-mcrv) does not apply to 1.13.0. The local uploader validates supplied file IDs as UUIDs.
- **CVE-2026-44196, password-only TOTP bypass:** [The fork advisory](https://github.com/smp46/pingvin-share-x/security/advisories/GHSA-j679-vp39-qwqq) concerns 1.14.1-1.16.2. Original `AuthService.generateToken` checks `totpVerified`, so I did not attribute this separate bypass to your version.
- **CVE-2025-65945, jws:** The dependency is flagged, but [the advisory](https://github.com/advisories/GHSA-869p-cjfg-cm3x) explicitly excludes jsonwebtoken's verification interface. This project's JWT path does not demonstrate the vulnerable `createVerify` usage.
- **CVE-2026-90711, proxy-addr:** The locked library is affected, but [the specific CVE](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) requires particular IPv4-mapped IPv6 trust-subnet configuration. This application uses boolean trust. Finding 4 is a separate, supported proxy-trust defect.
- **React2Shell / CVE-2025-66478 and App Router findings:** This project uses the Pages Router and React 18. [The Next.js advisory](https://nextjs.org/blog/CVE-2025-66478) concerns affected App Router/RSC configurations. I did not label this service vulnerable to React2Shell simply because its framework is old.
- The fork's received-shares credential disclosure affects a feature added after this release; the endpoint is absent here.

## Recommended response

1. Add proxy-level login and reset rate limits immediately, sanitize forwarded headers, and close direct access around the proxy. Consider temporary VPN or IP-restricted access while preparing remediation, especially if the instance stores sensitive files.
2. Close conditional high-impact paths you use: disable OAuth self-registration where unverified email is possible, stop relying on private reverse-share access controls, and block the image optimizer while its exposure is assessed. A normal reverse proxy does not automatically fix these application decisions.
3. Back up the database, uploaded files, images, and configuration before changing releases. Make the backup consistent by pausing writes. Test recovery and migration on a copy.
4. Move to a maintained codebase or take ownership of maintaining this fork. The original author recommends [Pingvin Share X](https://github.com/smp46/pingvin-share-x). Its latest stable release at review time is [v2.0.0](https://github.com/smp46/pingvin-share-x/releases/tag/v2.0.0), containing the application fixes above. Its S3 transfer changes require migration configuration; follow the release notes.
5. Treat the fork as a migration candidate that still needs a dependency review. Its v2.0.0 frontend lock still pins Next 14.2.35, which is [unsupported](https://nextjs.org/support-policy). It has newer sharp 0.35.4, which addresses the cited libheif issue, but neither that update nor migration alone proves all current advisories resolved. Choose and validate a maintained framework/dependency baseline and a rebuilt image.
6. Verify fresh dependency audits, the final container's OS/native-library scan, and end-to-end authentication and file-authorization checks before restoring normal exposure. Avoid `npm audit fix --force` as a deployment plan: framework and mail-library major upgrades require compatibility work and application flaws need separate fixes.

## What remains unverified on your server

The running image digest and architecture; exact Node/Alpine/native-library versions inside that image; installed-package SBOM; reverse-proxy type, rate limits, and header sanitation; any alternate exposed ports; OAuth providers and settings; anonymous/reverse-share settings; S3 and email use; and whether there are indicators of compromise.

Docker and a container scanner were unavailable in this workspace. Registry metadata and source locks were examined, but the actual running image was not unpacked or OS-scanned. No production credentials or secrets were requested or inspected. Application code and lockfiles remain unchanged.
