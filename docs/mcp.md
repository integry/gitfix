# Authenticated MCP

ProPR exposes `/api/mcp` through the official TypeScript MCP SDK. It serves
the **2026-07-28 stateless protocol and 2025-11-25 Streamable HTTP** on the
same URL using `createMcpHandler({ legacy: 'stateless' })` and one catalog.
There is no session-global selected instance. MCP authentication is separate
from the existing GitHub-bearer API middleware.

## Direct instance setup

Configure an ordinary working ProPR instance, including GitHub browser OAuth,
its existing session secret, Redis, agents and repository access. Then set:

```dotenv
MCP_ENABLED=true
MCP_PUBLIC_ORIGIN=https://your-instance.example
MCP_INSTANCE_ID=your-stable-instance-identifier
MCP_ENCRYPTION_KEY=<32 random bytes, base64 encoded>
```

Generate the encryption key with `openssl rand -base64 32`. Store it in the
instance secret manager; do not paste it into chat. Preserve the instance ID
and key across restarts. Missing/invalid required configuration fails startup
with an explicit diagnostic. MCP is disabled by default and cannot be enabled
in demo mode. Normal API rate limits remain in effect; OAuth endpoints also
use the SDK's rate limits. No default key or administrator session is created.

The reverse proxy must route `/api/mcp`, `/.well-known/*`, `/authorize`,
`/token`, `/register`, `/revoke`, `/mcp/*` and the existing `/api/auth/*` routes
to this API. Preserve the MCP protocol and parameter headers. Do not cache
private responses or buffer streaming output. The canonical public origin
must match the externally visible API origin; frontend UI links continue to
use `FRONTEND_URL`. Set the existing `GH_OAUTH_CALLBACK_URL` to the instance's
GitHub callback `/api/auth/github/callback`, and register that exact URL in
the GitHub OAuth application. This GitHub callback is distinct from the
chat client's OAuth callback.

Discovery endpoints:

* `/.well-known/oauth-protected-resource/api/mcp`
* `/.well-known/oauth-authorization-server`

Use the exact `https://your-instance.example/api/mcp` as the OAuth `resource`
in authorization, code exchange and refresh. Public clients use
authorization-code + S256 PKCE. Codes last 60 seconds and are consumed
transactionally. Access tokens last five minutes. Refresh tokens rotate;
reuse revokes the entire 30-day grant, including newly rotated access tokens.
GitHub credentials are separately encrypted server-side and never returned
to clients. Instance membership, allowlist and repository access are checked
again for every call. The connected-app page is `/mcp/apps`.

## Client compatibility and verified upstream details

Verified against published npm packages on 2026-09-10:
`@modelcontextprotocol/server`, `node`, `client` 2.0.0 and
`@modelcontextprotocol/sdk` 1.30.0. v2 provides both protocol eras; its OAuth
helpers cover Resource Servers. The maintained v1 SDK supplies Authorization
Server routing and validation, with a durable ProPR provider. The lockfile
records the exact installed package versions.

Sources: [July specification](https://modelcontextprotocol.io/specification/2026-07-28),
[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

CIMD metadata uses a public HTTPS URL, bounded 32 KiB JSON, five-second
timeout, no redirects and DNS-pinned public addresses. DCR remains available.
Only public PKCE clients (`none`) are supported. New CIMD documents with
`token_endpoint_auth_methods_supported` are intersected with `none`; a legacy
`private_key_jwt` preference does not override that supported intersection.

Use the exact callback displayed by the host; never register wildcard
callbacks. [ChatGPT's official authentication guide](https://developers.openai.com/plugins/build/auth)
currently documents callback-ID-specific
`https://chatgpt.com/connector/oauth/{callback_id}` and the stable
`https://chatgpt.com/connector_platform_oauth_redirect` for compatible issuer
identification modes. Its management page supplies the actual URL and CIMD
document. ProPR advertises issuer-response identification and includes `iss`
matching the metadata issuer (including its trailing slash) on success/denial.

[Claude's authentication reference](https://claude.com/docs/connectors/building/authentication)
documents `https://claude.ai/api/mcp/auth_callback` for hosted surfaces.
Native Claude Code uses loopback callbacks. **Verified compatibility
limitation:** ProPR enforces exact callback matching including loopback
ports, whereas the SDK/Claude CIMD flow supports RFC 8252 ephemeral-port
matching. Use DCR registering the actual callback or a fixed-port registered
client for native hosts. The [Claude Code guide](https://code.claude.com/docs/en/mcp)
documents `--callback-port` and HTTP transport setup. Hosted Claude CIMD does
not need the loopback exception. No live ChatGPT/Claude OAuth session has
been exercised by the local fixture tests.

## Connect

Direct access does not require Connect. To explicitly trust a Connect
gateway, additionally configure:

```dotenv
MCP_CONNECT_TRUST=true
MCP_CONNECT_ISSUER=https://mcp.propr.dev
MCP_CONNECT_JWKS_URL=https://mcp.propr.dev/.well-known/jwks.json
MCP_CONNECT_INSTALLATION_ID=<numeric installation ID>
MCP_CONNECT_INTROSPECTION_URL=https://mcp.propr.dev/internal/mcp/introspect
MCP_CONNECT_INTROSPECTION_SECRET=<instance-specific server credential>
```

Existing `PROPR_GH_RELAY_URL`/`PROPR_GH_RELAY_TOKEN` are additionally needed
for optional credential grant redemption. The [Connect contract](mcp-connect-contract.md)
specifies required claims, current membership/revocation semantics, scope
intersection and gateway errors. Public gateway OAuth, routing registry,
tunnels and the Connect site are companion-repository work. Configuration
examples are not evidence that the hosted endpoint has been deployed.

## Tools and ordinary workflows

The [capability matrix](mcp-coverage.md) maps supported operations to tools.
`tools/list` is authoritative for the current user's scopes and instance
permissions. Scope families are `read`, `plan`, `publish`, `execute`, `review`,
`merge`, `deploy`, `manage`; scopes never grant extra GitHub or instance access.
Repository restrictions are explicit lists. Administrative tools additionally
require the existing `instance.manage_settings`, `instance.manage_agents` or
`instance.manage_runtime` permission. Goal and plan ownership is preserved.
Ordinary repository task history follows the existing shared repository model;
native goal tasks remain private and can only be mutated through goal controls.

Start with `get_connection`, `list_repositories`, `list_models` and
`resolve_reference`. Resolve ambiguity before mutating. `create_plan` creates
a draft; `publish_plan` creates GitHub issues with the non-executing
`propr-planned` label. `implement_plan` requires selected issue numbers and
models and uses the existing implementation handler. Auto-merge defaults off
and additionally requires merge scope. `create_goal` explicitly starts work.
`/merge` means updating a PR branch; `merge_pull_request` separately requires
the exact head and satisfied checks/reviews/branch protection.

Every mutation needs an 8–128 character `idempotencyKey`. Keep it unchanged
across retries of the same action. Reusing a key with different arguments
returns `IDEMPOTENCY_CONFLICT`. Receipts survive restarts; `get_operation`
returns accepted/completed/failed/running/unknown plus available target state.
An interrupted or uncertain external operation is not blindly replayed.
Inspect the target before using a new key. Publication marks a draft busy
before issuing GitHub requests; partial publication remains inspectable in
`plan_issues` and the draft, with marker comments identifying the operation.
Automatic recovery of uncertain external effects is not implemented.

Poll at the returned interval (normally three seconds); never unboundedly
poll in one request. `cancel_operation`, `cancel_goal` and `cancel_task`
distinguish a cancellation request from a stopped backend. A completed
external effect cannot be cancelled. PR command receipts identify the
GitHub comment while normal configured event intake starts the work.

Uploads are limited to 192 KiB per call and allowed file types. Plan uploads
use existing attachment processing; goal uploads are delivered as goal input
and also require execute scope. Read owned upload artifacts in 48 KiB chunks.
`get_attachment` also reads existing browser-uploaded plan/goal files (up to
the native 10 MiB limit) in 48 KiB chunks. Owned MCP uploads have authenticated
browser download links under `/mcp/artifacts/{id}`. Task changes default to a
file summary; request `detail: "diff"` with an exact path for 16 KiB chunks.
No tool downloads arbitrary remote URLs. Secret entry and browser push/login
flows stay in the browser. Tool responses are bounded at 256 KiB and redact
credential fields and recognizable token strings.

## Resources, prompts, text and voice

Resource URIs use `propr://instances/{instance_id}/`: `connection`,
`repositories`, `models`, `plans/{id}`, `goals/{id}`, `tasks/{id}`,
`changes/{task_id}`, `repositories/{owner}/{repo}`,
`repositories/{owner}/{repo}/pulls/{number}`, `artifacts/{id}` and
`{plans|goals}/{parent_id}/attachments/{id}`.
Reads invoke the same tool guards. Links never confer access. Tools provide
the same essential data without relying on a host's resource UI.

Prompts are `plan_change`, `implement_plan`, `start_goal`, `check_progress`,
`review_and_improve_pr`, `diagnose_failure`, `prepare_handoff`. Retrieval only
returns instructions, never mutates product state. Natural-language content
and repository data are not authorization.

Examples for text or a host's supported voice interface:

* “Find my reliability plan in acme/web-app and tell me what is still running.”
* “Draft a plan to improve retry handling. Let me review it before publishing.”
* “Publish that exact revision, then implement issues 31 and 32 with this model.”
* “Start a direct goal to investigate flaky tests; pause it after the first findings.”
* “Review PR 44, fix the findings, then show me the current checks before merging.”

Hosts differ in voice/MCP availability. This server does not claim that every
host or voice mode supports MCP. Durable IDs and concise summaries make
continuation possible without process/session conversation memory.

## Verification, rollout and rollback

Run `npm run test:mcp` for local OAuth, both SDK eras, signed delegation and
operation tests. `npm run test:mcp:browser` additionally needs Playwright and
Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`). Set
`MCP_CAPTURE_PREVIEWS=true` only when capturing changed UI evidence.

Recorded local results (2026-09-10):

| Check | Result |
| --- | --- |
| `npm run test:mcp` | 11 tests passed, zero failures/skips |
| `MCP_CAPTURE_PREVIEWS=true npm run test:mcp:browser` | 1 passed; Chromium desktop and 390px mobile consent/revocation |
| First targeted backend regression batch | 9 files, 85 tests passed |
| Shared-handler regression batch | 7 files, 61 tests passed (some overlap with the first batch) |
| `npm run typecheck`, `npm run typecheck -w @propr/api`, `npm run build` | Passed |
| ESLint on MCP, its tests and affected API/shared handlers | Zero errors; 11 complexity/parameter-count/nesting warnings |

The first regression batch covered authentication/token refresh, redirects,
Connect, goals, notifications, rate limits, instance/route authorization and
planner background lifecycle. The second covered token refresh, goals, task
cancellation, planner operation guards, implementation triggers and revert
guards. Run selected files through `node scripts/run-test-suite.mjs <files>`
for isolated databases and the repository's standard test environment.

The local integration fixtures exercise both official SDK clients and the
real SQLite migrations, draft creation/update/publication, implementation
label orchestration and queueing, followup, review/fix/ultrafix and guarded
merge, goal lifecycle, TODOs, notifications, settings and attachment upload/read.
GitHub, queue transport and agent capability boundaries are fixtures;
task-history transitions at the worker boundary are simulated. Concurrent
implementation requests are asserted to enqueue once. Existing backend
regression suites also exercise the shared handlers and authorization.
This is not a verified live end-to-end agent implementation/review/merge, live
GitHub OAuth, Connect tunnel, or hosted-client voice session. See the checklist
for remaining cross-repository and operator acceptance work.

Back up SQLite and the encryption key before enabling. The migration adds
`mcp_records`, `mcp_operations`, and a revision counter/trigger on task drafts.
Disabling `MCP_ENABLED` and restarting removes MCP/OAuth routes while preserving
grants for a later rollback. Revoke grants first when access must not resume.
Do not delete receipt rows while clients may retry: they are deduplication
evidence. Full migration rollback removes MCP storage and the trigger; export
needed audit/receipt evidence before that destructive operator action.
Issue execution claims live in `mcp_records` and prevent a new idempotency key
from launching an already requested issue again. Following an uncertain
partial publication/implementation, an operator must reconcile the receipt,
GitHub markers, issue labels and queue state before explicitly recovering it.
No deployment, auto-merge activation or production migration was performed.
