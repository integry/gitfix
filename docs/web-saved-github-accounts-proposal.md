# Web saved GitHub accounts: implementation proposal for #2272

Status: proposed, not implemented. This document records the broader-authentication
checkpoint requested in [#2272](https://github.com/integry/propr/issues/2272).
It does not claim that saved-account switching is available or that the issue is
resolved. Target: `1950-epic-cross-platform-dsk` (#1970). Related work:
[#2269](https://github.com/integry/propr/issues/2269) and desktop
[#2271](https://github.com/integry/propr/pull/2271); keep the desktop/logout work in
#2271 and #2270 independent.

## Why a picker alone is insufficient

Inspection of the current implementation found these coupled boundaries:

| Boundary | Existing implementation | Required change |
| --- | --- | --- |
| Browser authority | `packages/api/auth.ts` serializes the complete GitHub user, including OAuth credentials, into the Redis-backed Passport session. | A separate server-owned collection must be authoritative for membership, active identity, revocation, and revision. An old Passport snapshot cannot remain a second authority. |
| Refresh and expiry | `packages/api/authGithubTokens.ts` saves whole request-session snapshots; refresh coalescing is process-local. Terminal expiry destroys the session. It also synchronizes rotating credentials with durable per-user grants used by desktop. | Refresh must update only its original saved grant with concurrency checks; expiry must invalidate only that grant. Preserve durable grant rotation coordination without deleting another surface's grant. |
| Login callbacks | Both GitHub Passport and Connect callbacks establish a login immediately. Connect separately validates the redeemed access token through GitHub `/user`; its returned avatar currently comes from the relay response. | Adding an account needs a pending, verified identity and explicit confirmation before activation. Use the verified GitHub profile for both username and avatar. |
| Cookies and request forgery | The session cookie is HttpOnly, SameSite=Lax, conditionally Secure, and optionally domain-scoped. Logout currently mutates state through GET. CORS permits missing Origin and, for domain-cookie deployments, matching subdomains. OAuth state and the exact-origin desktop pairing guard are separate protections. | Keep OAuth state and cookie protection. Introduce browser-account mutation CSRF checks; CORS and SameSite alone do not supply this contract. Keep desktop pairing policy intact. |
| Sockets | `packages/api/services/socketAuthentication.ts` reloads Passport and rejects changed identities on revalidation, with a default 60-second interval. `socketService.ts` also broadcasts to rooms. | Disconnect and reject stale browser revisions before queued subscriptions and outbound delivery; periodic revalidation alone is insufficient. |
| HTTP/UI state | `propr-ui/src/api/apiClient.ts` tracks desktop scopes. `useCurrentUserBootstrap.ts` uses a constant `browser` configuration key. | Add a browser generation boundary covering request dispatch, retries, body consumption, current-user bootstrap, and account-specific UI state. |
| Notifications | `NotificationCenterContext.tsx` already guards some late results and is keyed by user in `App.tsx`. `useBrowserPush.tsx` reconciles an origin-wide subscription using a local owner hint. `public/service-worker.js` displays push payloads and changes badges without checking current session identity. | Cover browser push registration, queued delivery, notification actions, and badges as well as React state. Local owner hints cannot authorize a session or a notification. |

Hosted mode adds a compatibility constraint: the UI at `app.propr.dev` and the API
at `t-<instance>.propr.dev` deploy independently. The supported tunnel cookie is
host-only on the API hostname; it must not be widened to share accounts between
instances. Existing custom GitHub OAuth, Connect, local browser, demo, bearer,
and desktop login flows must continue to work.

This requires changing browser session authority, callback completion, refresh
persistence, and notification delivery together. Implementing just the picker
would leave switch/logout races and stale notification delivery unresolved.

## Proposed bounded scope

Implement one browser session with one active account **per API instance and
browser cookie jar**. All tabs sharing that cookie switch together. Different
browser profiles can remain independent. Do not claim isolated users per tab or
per desktop window. Cross-origin preview tabs sharing a domain cookie also share
the active account, even though BroadcastChannel cannot reach across origins.

Keep new browser logic in dedicated API and UI modules. Add narrow browser-only
hooks to existing authentication, request, and socket boundaries. Do not alter
desktop transport, desktop activation/logout, desktop account storage, or the
desktop bridge contract. Reuse a transport-independent account row if one is
available when implementation begins; do not wait for or copy #2271's transport
work. No provider-side logout, credential reset, live deployment, or Windows work.

### Server-owned records and transitions

Use the existing database transaction and credential-encryption facilities for
these new records, with migration support for the databases the API supports:

- Browser collection: random opaque identifier, schema version, active saved
  session ID (nullable), monotonic revision, expiry, and CSRF secret.
- Saved session: random opaque identifier, owning collection, verified numeric
  GitHub ID, current GitHub username/avatar, encrypted OAuth grant, grant revision,
  expiry, and state (`authorized`, `reauth-required`, or `removed`). Cap each
  collection at ten saved accounts initially.
- Pending authorization: random one-use identifier, collection and starting
  revision, OAuth state binding, optional expected GitHub identity for
  reauthorization, expiry (ten minutes), verified encrypted grant, and confirmation
  state. Pending grants are never used for API access or durable grant capture.

The HttpOnly session contains only the collection reference after migration.
Neither an account ID, username, revision, broadcast message, nor a browser
storage value grants authority. Resolve ownership from the authenticated cookie
on every collection operation. Account IDs from another collection fail with the
same response as nonexistent IDs. Never list accounts from an instance-wide
GitHub grant table.

Switch, confirmation, removal, and sign-out use a transaction with an expected
collection revision. Only one competing operation succeeds; stale callers receive
`409 BROWSER_SESSION_CHANGED` and reload authoritative state. Rotate the CSRF
secret and increment the revision on active identity transitions. Signing out
removes the selected grant, sets the active ID to null, and leaves other saved
grants selectable. Do not automatically select a remaining grant on reload.
Removing an inactive grant leaves the active identity intact but still invalidates
stale collection-management forms. Clear or invalidate pending authorizations
when their starting revision is superseded.

Token refresh uses saved-session and grant revisions, not the active account ID
at completion time. An old request may update its still-authorized original grant,
but it cannot activate it, recreate a removed grant, or overwrite another account.
Retain expiry/revocation tombstones long enough to reject old session snapshots;
never reconstruct a missing collection from a migrated Passport snapshot.
Storage outages fail closed. Existing shared durable GitHub grant rotation must
remain coordinated; removing a browser grant does not revoke desktop credentials.

### OAuth and account API

Proposed browser-session-only endpoints under `/api/auth/accounts`:

| Operation | Contract |
| --- | --- |
| `GET /` | Return explicit presentation fields, active selection, revision, and CSRF token with `Cache-Control: no-store`. Also works for a signed-out collection; returns no OAuth credentials. |
| `POST /authorizations` | CSRF-protected add/reauthorize start. Bind one-use OAuth state to this collection and revision before navigation. |
| `GET /authorizations/:id` | Return only a pending verified profile for confirmation, scoped to the cookie's collection. |
| `POST /authorizations/:id/confirm` | Confirm the displayed verified GitHub identity, consume the pending grant atomically, and activate it. |
| `DELETE /authorizations/:id` | Cancel and discard the pending grant without changing the active account. |
| `POST /switch` | Activate an owned, authorized saved session after current whitelist/authorization and expiry checks. |
| `POST /sign-out` | Require the expected selected account and revision; remove only that account and persist active=null. |
| `DELETE /:id` | Remove an owned saved account; do not affect another browser collection or desktop session. |

All mutations require a session-bound synchronizer token in a custom header,
the expected revision, and an exact trusted UI Origin. Reject absent, malformed,
`null`, or untrusted Origins. Use an explicit configuration for trusted preview
origins instead of extending trust to every cookie-domain sibling. Account-list
and CSRF-token reads require the same trusted browser origin (or validated
same-origin browser request) so broader legacy CORS cannot expose them to an
untrusted sibling. Bearer credentials cannot manage browser collections.

Keep both OAuth providers and their existing state verification. Adding an account
must not overwrite the active Passport login at callback time. Verify the returned
GitHub profile, then show “Continue as @username” with its real avatar and a
cancel/retry action. For reauthorization, a mismatched numeric GitHub ID is rejected,
not substituted. For an unspecified new account, the verified identity must be
explicitly confirmed. GitHub may return an already-selected provider account;
explain how to retry without assuming the provider offers an account chooser.
Expired, replayed, or superseded callbacks cannot activate or capture credentials.

Preserve the existing `/api/auth/github` login entry point. For collections, route
existing GET logout links to a confirmation surface that submits the protected
POST; GET must not mutate collection state. Preserve hosted tunnel selection and
validated redirect handling throughout. A signed-out collection shows the picker
and never auto-launches OAuth merely because a saved grant remains.

### Browser invalidation and notifications

Publish a non-secret browser revision through a browser-specific state module.
On transition, synchronously hide account content, invalidate the local generation,
abort HTTP work, disconnect sockets, revoke object URLs, clear account caches and
badges, and remount the account subtree only after fetching the new identity.
Capture generation at request start and check again after response body parsing
and before retries or UI commits. Cover A→B→A as well as A→B: user ID alone is not
a sufficient generation key.

Include the expected server revision on cookie-authenticated application requests
and socket handshakes. Reject stale requests before side effects. Requests already
authorized before a transition remain bound to their original principal; switching
does not undo committed work or reassign an in-flight operation to the new user.
Suppress stale response presentation. Fence browser socket delivery and
subscription completion by revision, including delayed room joins and reconnects.
Use cross-process invalidation for APIs sharing sessions; an in-process event
emitter cannot be the only revocation mechanism.

Use BroadcastChannel with a storage-event fallback, keyed by canonical API origin,
for prompt same-origin tab invalidation. Messages carry only invalidation hints;
receivers fetch the authoritative session. Revalidate on focus, visibility change,
and restored pages before showing account content. Server revision checks and
socket invalidation cover missed broadcasts and preview tabs on other origins.
Suspended/offline tabs must revalidate on resume; broadcasts cannot guarantee
instant execution in a suspended browser process.

Bind browser push registration and delivery to the owning browser collection and
revision in addition to the existing user ownership checks. Cancel obsolete
delivery jobs and prevent delayed registration from re-enabling the old account.
The service worker must validate an opaque delivery reference against the current
server session before showing account content, setting a badge, or following a
notification action. Reject stale references and suppress account content when
validation is unavailable, including with all tabs closed. Do not use localStorage
owner IDs as authorization. Close already-visible old notifications where browser
APIs permit it. Content already displayed by the OS cannot be guaranteed to be
recalled; do not claim otherwise. Keep the existing shell-only cache policy.

### Migration and deployment

1. Add the server records and capability metadata with the feature disabled.
   Implement and verify transitions and legacy-session import before exposing UI.
2. Import a valid existing single-account session once, transactionally, as the
   active saved grant. Rotate the session against fixation and maintain a bounded
   server-side migration mapping so concurrent legacy requests converge. Subsequent
   old snapshots cannot re-import removed accounts. Preserve the user's existing
   authentication without asking for a credential reset.
3. Ship a compatible browser UI and service worker. Enable the picker only when
   the API advertises the complete revision/CSRF/notification contract and the
   required service worker is active. Unsupported APIs keep their existing
   single-account UI. An unsupported old UI must be blocked from using migrated
   sessions, rather than silently making unversioned requests as another account.
4. Upgrade all API replicas sharing a session namespace before enabling migration.
   Do not mix old Passport-only replicas with authoritative collections. Preserve
   cookie host/domain/security settings and `SESSION_SECRET`; provision the
   existing supported credential-encryption key consistently across replicas.
   Document database backups, retention/cleanup, and explicit trusted UI origins.
5. Rollback may disable adding/switching accounts, but must retain the new
   authoritative reader and protected sign-out for migrated sessions. Rolling back
   to a pre-migration reader is unsupported: it could revive stale Passport state.

## Required integration gates

Use two independently authorized synthetic GitHub users, A and B, on one running
API, plus a separate browser cookie jar C. Stub provider token exchange and profile
responses, not the collection authority. Exercise real HTTP cookies, the production
session middleware/store, database transactions, Socket.IO clients, and browser
contexts. Use controllable barriers for races rather than timing-only sleeps.

| Gate | Required evidence |
| --- | --- |
| Two accounts and reload | Authenticate and confirm A/B independently, switch both ways, reload, sign out B, reload signed out, explicitly select retained A. Verify no credentials appear in responses, DOM, storage, or URLs. |
| Wrong identity | Reauthorize A but return B from GitHub; reject without replacing A. Cancel a new-account confirmation; no account is saved or activated. Verify the displayed avatar and username come from the verified profile. |
| Ownership and CSRF | C cannot list/switch/remove A/B by copying IDs. Reject bearer-only account operations, missing/wrong CSRF, untrusted/absent/null Origin, and mutating GET attempts. Preserve OAuth state and redirect rejection tests. |
| Concurrent authority | Race A→B against sign-out, removal, confirmation, and refresh on two API processes. One revision wins; stale saves and callbacks cannot restore authentication. |
| Late HTTP | Delay headers, body parsing, bootstrap, notification counts/preferences, and token-refresh retries across A→B and A→B→A. No stale content or retried mutation commits as the new user. |
| Late sockets | Delay handshake, authorization, room join, broadcasts, and reconnect across switch/logout. Old browser revisions neither receive account payloads nor retain subscriptions. |
| Notifications | Delay push registration, queued push, badge writes, and notification actions across transitions; repeat with all tabs closed. Check stale delivery rejection in the service worker and server. |
| Expiry and recovery | Expire an inactive grant, active grant, collection, and pending OAuth separately. Preserve other saved accounts; transient provider/store failure does not become another identity or silently restore logout. |
| Cross-tab | Verify same-origin broadcasts, disabled storage/broadcast, focus/resume, back-forward cache restoration, and different-origin preview tabs sharing cookies. All use the server-selected identity; separate cookie jar C is unaffected. |
| Compatibility | Test legacy import races and tombstones, old UI/new API, new UI/old API, hosted Connect redirects and cookies, custom OAuth, local browser, demo, and unchanged desktop/bearer auth. |

Only after these gates pass should the implementation PR claim `Closes #2272`,
link #2269 and #2271, and target `1950-epic-cross-platform-dsk`. Capture focused
picker/confirmation screenshots from the running UI at that point. This proposal
does not change application visuals and needs no preview artifacts.

## Baseline verification (2026-09-10)

The following existing tests passed during inspection:

```sh
NODE_ENV=test npx tsx --experimental-test-module-mocks --test \
  packages/api/test/oauthState.test.ts \
  packages/api/test/connectAuth.test.ts \
  packages/api/test/sessionCookie.test.ts \
  packages/api/test/authGithubTokens.test.ts \
  packages/api/test/socketAuthentication.test.ts
# 47 tests passed; 0 failed, skipped, or cancelled.

npm exec --workspace propr-ui -- vitest run \
  src/serviceWorker.test.ts \
  src/contexts/NotificationCenterContext.test.tsx \
  src/api/proprApi.logout.test.ts \
  src/hooks/useBrowserPush.test.tsx
# 37 tests passed across 4 files.
```

These are baseline checks, not the new two-account integration gates above.
Provider exchanges are mocked; no real GitHub authorization, live deployment,
multi-replica migration, or real-browser account switching was exercised. The
API run used the test SQLite database and emitted an optional preview-credential
lookup warning for its unmigrated table; it is not evidence of production-store
integration. No application implementation or desktop code was changed.
