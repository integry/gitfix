# ProPR MCP Connect delegation contract (version 1)

This is the concrete integration contract for `integry/propr-routing` and
`integry/propr-site`. The instance implementation is in `packages/api/mcp`.
This repository does not contain the Connect gateway or site. Companion PR
links must be attached by the coordinating operator; none have been created
by this implementation task. **These changes do not make mcp.propr.dev live.**

## Public endpoints and ownership

* Direct: `https://<instance>/api/mcp`. The instance owns OAuth. This works with
  the instance's own GitHub browser login, independently of Connect.
* Hosted: `https://mcp.propr.dev/mcp`. Connect owns public OAuth, consent,
  durable grants, refresh rotation and connected-app revocation.
* One hosted grant permanently binds one numeric installation ID and one
  stable instance ID. Changing target requires fresh consent and a new grant.
* Gateway authenticates the client token, checks grant revocation and current
  installation membership, then resolves the active tunnel from its registry.
  No client-selected host, tunnel URL, target header or GitHub user header is
  authoritative. Do not create global mutable current-instance state.

## Gateway-to-instance request

Forward the original request method, body and relevant MCP headers to
`/api/mcp` through the registered Cloudflare Tunnel. Replace Authorization
with `Bearer <delegation>`. Strip incoming user/routing/forwarded-identity
headers. Never forward a client access token, refresh token or GitHub token.
Preserve `MCP-Protocol-Version`, `Mcp-Param-*`, Accept and Content-Type.
Preserve streaming, response backpressure and cancellation; disable buffering
and private-response caching. Return `Cache-Control: no-store` on all paths.

The delegation is an ES256 JWT. JOSE header:

```json
{"alg":"ES256","kid":"rotation-key-id","typ":"propr-mcp-delegation+jwt"}
```

Example claims (illustrative identifiers):

```json
{
  "iss": "https://mcp.propr.dev",
  "aud": "urn:propr:instance:stable-instance-id",
  "sub": "1234567",
  "instance_id": "stable-instance-id",
  "installation_id": "7654321",
  "grant_id": "durable-connect-grant-id",
  "scope": "read plan publish execute review",
  "repositories": ["owner/repository"],
  "contract_version": 1,
  "iat": 1789070400,
  "exp": 1789070460,
  "jti": "unique-delegation-id"
}
```

`sub` is the numeric GitHub user ID encoded as a decimal string, never a
username. Installation ID is also a decimal string. The maximum lifetime is
60 seconds; allowed clock skew is 5 seconds. No wildcard repositories or
scopes. Scope families are `read plan publish execute review merge deploy
manage`. The instance checks all bindings with `jose`, fixed ES256 and a
configured JWKS endpoint, then applies its own current allowlist, permissions,
GitHub repository access and object ownership. `kid` selects from the fixed
JWKS URL, never a key URL provided inside the token. Rotate signing keys with
at least a 65-second overlap after stopping issuance with the old key.

## Revocation and membership introspection

The instance calls the configured `MCP_CONNECT_INTROSPECTION_URL` **on every
delegated request**, without caching positive results. The gateway must
authorize `MCP_CONNECT_INTROSPECTION_SECRET` as a server credential specific
to this installation/instance pair and reject requests for other bindings.

```http
POST /internal/mcp/introspect
Authorization: Bearer <instance-specific-server-credential>
Content-Type: application/json
```

```json
{"grant_id":"durable-connect-grant-id","subject":"1234567","instance_id":"stable-instance-id","installation_id":"7654321"}
```

Success response:

```json
{
  "active": true,
  "grant_id": "durable-connect-grant-id",
  "subject": "1234567",
  "instance_id": "stable-instance-id",
  "installation_id": "7654321",
  "scope": "read plan publish execute review",
  "repositories": ["owner/repository"]
}
```

Revoked grants or removed memberships return `active:false`. Current scopes
and repositories are intersected with the signed claims, so reductions apply
immediately even to an unexpired delegation. Network failure fails closed.

Optionally return a one-use `credential_grant` when the instance lacks the
user's GitHub credential. It is redeemed server-side through the existing
`redeemConnectAuthorizationCode` contract using `PROPR_GH_RELAY_URL` and
`PROPR_GH_RELAY_TOKEN`. The redeemed numeric user ID must match `sub`.
Never return GitHub credentials directly in the delegation. Without a
redeemable grant or stored credential, the instance returns
`GITHUB_CREDENTIAL_REQUIRED` and the user must sign in through the browser.

## Gateway failure mapping

* Invalid/expired client OAuth token: 401 with hosted protected-resource metadata.
* Revoked grant/membership or installation mismatch: 403 `ACCESS_REVOKED`.
* No active registered tunnel: 503 `INSTANCE_UNAVAILABLE`, `Retry-After: 5`.
* Registry says contract/protocol unsupported: 409 `INSTANCE_VERSION_MISMATCH`.
* Introspection unavailable: 503 `CONNECT_UNAVAILABLE`.
* Preserve instance scope/precondition/tool errors; do not turn them into
  successful empty responses. Do not retry mutations with new idempotency keys.

The gateway must verify registry compatibility before forwarding. The instance
uses the official SDK to classify both July 2026 stateless and November 2025
Streamable HTTP requests on the same endpoint; there is one tool catalog.

## Companion acceptance gates

- Routing: hosted OAuth lifecycle, registry resolution, token replacement,
  JWT/JWKS rotation, authenticated introspection/credential redemption,
  unavailable/version mismatch paths, cancellation and uncached streaming.
- Site: installation selection and explicit fixed-target consent, connected
  app listing/revocation, credential bootstrap links, mobile/browser testing.
- Shared fixture: `packages/api/test/mcpDelegation.test.ts` verifies the JWT
  cryptography, introspection restrictions, revocation, separate credentials
  and no token forwarding. Live tunnel/gateway interoperability remains an
  operator verification step, not a result claimed by this fixture.
