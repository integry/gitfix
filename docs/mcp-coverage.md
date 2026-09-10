# MCP capability coverage and acceptance checklist

The executable catalog is `packages/api/mcp/tools.ts` and its `tools*.ts`
modules. `tools/list` filters capabilities by the authenticated grant and
current administrator permissions. All listed tools have implementations;
there is no generic REST or shell execution tool.

Core [PR #2291](https://github.com/integry/propr/pull/2291) remains the coordinating
epic for [routing PR #180](https://github.com/integry/propr-routing/pull/180) and
[site PR #90](https://github.com/integry/propr-site/pull/90). Routing PR #180 is merged at `1fcf82fd1a843fbdf199d79b8f92843dc74a89e0`.
The catalog covers the supported backend workflows below, including non-secret
configuration. Live provider/host acceptance and independent root verification
remain separate gates.

## Product-operation mapping

| Product operation | MCP tool(s) or explicit boundary |
| --- | --- |
| Identity, instance, permissions, setup | `get_connection`, `get_setup_status` |
| Configured repositories and enabled agent models | `list_repositories`, `list_models` |
| Exact/fuzzy reference lookup | `resolve_reference`; ambiguous names return candidates |
| Draft list/read/create/update/delete | `list_plans`, `get_plan`, `create_plan`, `update_plan`, `delete_plan` |
| Generate/refine a plan | `generate_plan`, `refine_plan` |
| Publish GitHub issues | `publish_plan`; publication does not start implementation |
| Selected issues, model, epic, bounded ultrafix and explicit auto-merge | `implement_plan` |
| Plan scheduling | `pause_plan`, `resume_plan` |
| Native goal capabilities/start/read/input | `get_goal_capabilities`, `create_goal`, `list_goals`, `get_goal`, `send_goal_input` |
| Goal controls/model changes | `pause_goal`, `resume_goal`, `cancel_goal`, `set_goal_model` |
| Task progress, history and bounded execution logs | `list_tasks`, `get_task`, `get_task_events`, `get_task_logs` |
| File changes and followup | `get_task_changes`, `send_task_followup` |
| Task/operation cancellation and receipts | `cancel_task`, `get_operation`, `cancel_operation` |
| Delete inactive task history | `delete_task`; bulk cleanup uses explicit individual handles |
| PR read/review/fix/ultrafix | `get_pull_request`, `get_pull_request_discussion`, `review_pull_request`, `fix_review_findings`, `run_ultrafix`; exact comment/F# selection, reviewed head, partial coverage and consumed findings |
| Update branch (`/merge`) | `update_pull_request_branch` |
| Guarded PR merge | `merge_pull_request` |
| Preview/revert a PR commit | `get_pull_request_revert_preview`, `revert_pull_request_commit`; exact commit, comment and head |
| Indexed overview/tree/path/search/freshness | `get_repository_context` |
| Indexing launch/cancellation | `index_repository`, `stop_repository_indexing`; explicit repository/branch |
| Repository TODO CRUD/category CRUD | `list_todos`, `get_todo`, `create_todo`, `update_todo`, `delete_todo`, `list_todo_categories`, `create_todo_category`, `update_todo_category`, `delete_todo_category` |
| TODO category movement/order | `move_todo`; order fields on TODO/category update |
| Star/hidden repository preferences | `get_repository_preferences`, `update_repository_preferences` |
| Notifications read/dismiss/bounded bulk update | `list_notifications`, `mark_notification_read`, `dismiss_notification`, `update_notifications` |
| Notification preferences, categories and quiet hours | `get_notification_preferences`, `update_notification_preferences`, `set_notification_category_preferences` |
| Bounded plan/goal attachments and owned upload artifacts | `upload_attachment`, `get_artifact`, `get_attachment`; authenticated download links, no remote URL download |
| Execution/model settings | `get_execution_settings`, `update_execution_settings` |
| Repository configuration | `get_repository_configuration`, `create_repository_configuration`, `update_repository_configuration`, `remove_repository_configuration` (branch/alias/enabled/CI followup/visual preview policy); instance permission and explicit repository grant required |
| Direct agent configuration | `get_agent_configuration`, `create_agent_configuration`, `update_agent_configuration`, `remove_agent_configuration`; actual types/models, alias, enablement, model labels/reasoning, CLI versions; new agents start disabled for secure login |
| Synthetic-agent composition | `create_synthetic_agent`, `update_synthetic_agent`, `remove_synthetic_agent`; pool models/members, strategy, priority and usage thresholds; existing reference/default guards |
| Advanced indexing policy | `get_indexing_configuration`, `update_indexing_configuration`; primary/fallback alias:model, prompt, enablement and runtime cooldown state |
| Provider policy | `get_provider_policy`, `update_provider_policy`, `get_provider_status`, `get_provider_usage`, `refresh_provider_usage`, `detect_provider_service`; Agent Tank service origin and enablement, no credential entry |
| Execution/review/context | `get_execution_settings`, `update_execution_settings`; worker concurrency, analysis/planner models, review model/prompt/context enablement/model/budget, reasoning and bounded ultrafix defaults |
| Workflow labels and keywords | `get_`/`update_` tools for `followup_keywords`, `followup_ignore_keywords`, `primary_processing_labels`, `pr_label`, `ai_primary_tag` |
| Runtime package configuration/build | `get_runtime_configuration`, `update_runtime_configuration` |
| Instance membership administration | `list_instance_members`, `add_instance_member`, `set_instance_member_role`, `remove_instance_member`, `get_instance_role_audit`; existing last-admin guards |
| Shared repository chat history | `get_repository_chat`, `save_repository_chat_message`, `delete_repository_chat_message` |
| GitHub credentials, provider login, agent secrets, push subscription | Browser settings/login links from connection/setup; never collect secrets through tools |
| Deployment/release | Existing operator CLI/scripts only. No corresponding deployment backend was found; no fictitious deployment tool is advertised. `deploy` is reserved and confers no operation by itself. |

## Implementation checklist

- [x] Official maintained SDK and published protocol/package verification.
- [x] Both protocol eras on the same URL with one real tool implementation.
- [x] Separate MCP authentication before GitHub-bearer middleware.
- [x] Standalone direct OAuth, durable encrypted grants, S256 PKCE, code
  consumption, refresh rotation/reuse revocation, metadata, public CIMD/DCR.
- [x] Exact redirect validation and explicit callback/loopback limitation.
- [x] Browser consent with requested-scope subset and repository selection, CSRF protection, connected
  apps and revocation; Chromium desktop/mobile behavior and image evidence.
- [x] Opt-in signed Connect delegation, audience/instance/installation/user
  binding, persistent key/proof registration, per-request online validation and
  proof-bound server-to-server GitHub credentials against the actual routing contract.
- [x] Scope, configured-repository, current GitHub and instance access checks;
  owner checks for plans/goals/TODOs/artifacts and private native goal tasks.
- [x] Revision counter invalidated by all draft writers through a SQLite trigger.
- [x] Durable mutation keys, atomic duplicate exclusion, restart-readable
  receipts, bounded polling, explicit uncertain external outcomes.
- [x] Fixed tool schemas, annotations, bounded results and credential redaction.
- [x] Resources and mutation-free workflow prompts; durable text/voice handles.
- [x] Direct/Connect operator docs, wire contract, rollback and capability mapping.

## Verification checklist and known limits

- [x] OAuth HTTP token exchange, invalid PKCE/resource/redirect, replay,
  concurrent refresh reuse, revocation and encrypted storage tests.
- [x] Both official SDK clients discover tools/resources/prompts, invoke real
  SQLite draft creation/revision/publication and observe worker-state fixtures.
- [x] Both SDK eras invoke real implementation/followup handlers with GitHub
  and queue fixtures; concurrent starts enqueue once; explicit auto-merge
  false clears the label. Guarded PR review/fix/ultrafix/update/merge transitions.
- [x] Both SDK eras exercise persisted goal lifecycle, TODO/category movement,
  deletion replay, notifications, settings, preferences and attachment chunks.
- [x] Real ES256/JWKS tests plus the pinned actual Worker/core integration check
  online validation, proof/key/instance/installation/repository restrictions,
  encrypted credential handoff and membership/revocation denial.
- [x] SQLite file reopen and concurrent durable dedup test.
- [x] Browser consent/revocation test, CSRF denial and mobile overflow check.
- [ ] A live end-to-end agent run through generation → publication →
  implementation → followup → review/fix → guarded merge. Local tests do not
  provision Docker agents, spend provider credits or merge real PRs.
- [ ] Live GitHub login, ChatGPT/Claude OAuth and host voice sessions.
- [x] Companion PRs linked above; pinned routing/core integration runs locally.
- [ ] Final site capability reconciliation and root verification of both companion heads.
- [ ] Live tunnel unavailability/version mismatch/cancellation/streaming
  verification against the deployed gateway. The expected mapping is in
  `mcp-connect-contract.md`; the gateway is not part of this checkout.

Only secure setup boundaries remain browser/operator-only: GitHub/provider login,
agent secrets and environment variables, credential mount paths, custom agent
images/install sources, push subscriptions, and OAuth consent expansion. These
configure credentials, host execution or grant boundaries rather than ordinary
model/workflow preferences. Agent creation uses managed credential paths (Vibe
uses its supported fixed default path); the tool cannot choose a host path.
Creation does not authenticate or enable an agent. Repository addition outside
the current explicit grant returns `browser_required`, `changed: false`, and a
browser continuation; no repository or grant is silently added. Membership
administration retains its existing instance permission and last-admin guards.
Raw Docker streaming logs are not exposed; bounded persisted execution events
are available through `get_task_logs`. Deployment has no supported backend here.

Repository, direct-agent and synthetic-agent adapters include a revision of the
snapshot they read. The existing shared persistence lock checks that revision
before writing. A concurrent REST or MCP change produces a conflict; retry with
a fresh read and new operation key. No unrelated changes are overwritten. Indexing receipts track their actual indexing
queue job through completion and expose repository context freshness; they do not
pretend the indexing job is an implementation task.

Follow-up receipts retain `sourceTaskId` separately from the new durable
`jobId`/`continuation.taskId`. States distinguish `posted`, `queued`, `running`,
`completed`, `failed`, and `unknown`. A queue acknowledgement failure keeps the
posted comment/job handles and reports uncertainty, never success. Polling can
resolve an uncertain submission when its task appears. PR command receipts link
to tasks by their exact triggering comment in persisted job data, expose posted
review result IDs/URLs, and report the resulting current PR head. Ultrafix polls
the associated work epoch through loop completion; a newer loop cannot satisfy
an earlier receipt. Missing intake becomes `unknown` after two minutes instead
of remaining accepted forever; later polling can still find the task.

`get_pull_request_discussion` pages GitHub issue comments (maximum 20 per page),
returns 4096-character body chunks and parsed F# findings (current IDs honor the
worker’s seven-day age limit, known head and consumption state), and supports exact
comment/task lookup. New reviews persist reviewed head and task identity in the
existing review marker; legacy reviews explicitly report an unknown head.
`fix_review_findings` requires `reviewCommentId` and explicit `findingIds`, rejects
consumed IDs and known stale heads, and does not turn optional suggestions into
fix scope. Comment content remains untrusted data.

Uncertain external side effects remain `unknown` and require inspecting the
target. They are never reported as rolled back or blindly retried. In
particular, a partly published plan remains busy with persisted created issue
links. Cancelling a receipt cannot undo already published issues or comments.

## Prior Connect integration follow-up evidence (at 6147abc)

Run on 2026-09-10 with Node **v22.23.1**. Source identities:

- Core base: `ec8043b1ebc29d9a024476990895241c1256c1e4`, plus this **uncommitted**
  PR #2291 follow-up. The system owns the eventual commit.
- Core implementation/fixture SHA-256 reported by the runner:
  `ac4c403ac844fb0c3ed47025b347b34a615016908dfca285edbf622fce44a89b`.
  The runner defines and reports the hashed source set; this identifies the
  working implementation without pretending the old commit contains these fixes.
- Routing archive: `0c8ca02044c88b181395ca8e15425c0821e588e4`, unmodified source.
- Published SDKs actually loaded: server/node/client **2.0.0**, legacy SDK
  **1.30.0**. Routing dependencies come from that archive's lockfile.

Exact commands and final results:

```sh
MCP_ROUTING_REPOSITORY=/tmp/git-processor/clones/integry/propr-routing npm run test:mcp:connect
# 1 integration scenario passed, 0 failed, 0 skipped (4.664 s test process).

npm run test:mcp
# 12 passed, 0 failed, 0 skipped.

MCP_CAPTURE_PREVIEWS=true npm run test:mcp:browser
# 1 passed, 0 failed, 0 skipped; Chromium desktop/mobile consent captures.

node scripts/run-test-suite.mjs packages/api/test/connectAuth.test.ts packages/api/test/authGithubTokens.test.ts packages/api/test/instanceAuthorization.test.ts packages/api/test/routeAuthorization.test.ts packages/api/test/oauthState.test.ts
# 5 files, 45 tests passed; 0 failed (12.2 s).

npm run typecheck
npm run typecheck -w @propr/api
npm run build
# All passed.

npx eslint --config packages/api/eslint.config.js packages/api/mcp/connect.ts packages/api/mcp/config.ts packages/api/mcp/policy.ts packages/api/mcp/oauth.ts packages/api/mcp/browser.ts packages/api/mcp/clients.ts packages/api/mcp/server.ts packages/api/mcp/tools.ts packages/api/test/mcpConnectIntegration.test.ts packages/api/test/fixtures/routingD1.ts packages/api/test/mcpOAuth.test.ts packages/api/test/mcpOperations.test.ts packages/api/test/mcpDelegation.test.ts packages/api/test/mcpBrowser.test.ts scripts/mcp-connect-register.ts
# 0 errors, 9 complexity/parameter-count/nesting warnings.
```

For another operator, replace `MCP_ROUTING_REPOSITORY` with their routing Git
checkout containing the pinned commit. The runner makes a temporary Git archive,
installs with `npm ci --ignore-scripts --workspaces=false --no-audit --no-fund`,
and bundles `src/index.ts`, including the real relay authenticator, OAuth
server, MCP gateway and existing credential redemption endpoint. It prints
source identities and retains a `commits.json` in its temporary fixture directory.
The generic test runner skips the dedicated cross-repository case without its
fixture environment. Required PR CI now invokes the dedicated runner explicitly
as described below; that invocation cannot skip. The historical run had no skips.

The integration traverses actual production core `mountMcp`, `McpPolicy`,
`McpConnect`, `McpOAuthProvider`, tool catalog, plan handler, operation ledger,
resource and prompt implementations. Both public SDK clients reach core through
routing. There is no replacement policy, synthetic core principal, or invented
MCP gateway. The only infrastructure adapters are routing's existing unused
DurableObject base stub, a D1 API adapter executing the actual routing schema/SQL
and transactional batches on SQLite, local tunnel DNS mapping to core's HTTP
listener, and canned GitHub `/user`/repository responses. Unrecognized network
requests fail. Core uses a temporary SQLite file and real relevant migrations;
a second connection reopens it to verify persisted drafts.

Passing assertions cover:

- Persisted key creation and repeat registration through core's actual operator
  setup function; current tunnel/installation binding, wrong relay/tunnel denial,
  encrypted private-key storage and one-use registration assertions.
- Public discovery of all scopes; DCR, S256 PKCE/consent, bad verifier and code
  replay rejection; granted subsets and no GitHub credentials in public tokens.
- Both SDK eras: tool/resource/prompt discovery, actual `get_connection`,
  `create_plan`, duplicate mutation receipts, plan resource reads and prompts;
  two persisted core draft mutations, no provider work or GitHub publication.
- Exact claim types/audience/resource/key binding, online validation on each
  invocation, proof hash/audience/freshness, `pia_mcp_` issuance and real atomic
  redemption; encrypted core storage, consumed-code denial and renewal of a
  stale stored GitHub credential after browser consent.
- Wrong signed instance/installation/key/scope/repository, wrong proof key/hash,
  untrusted resource hint, malformed/discrepant validation responses, online
  service outage, tunnel outage, version mismatch, core malformed-JSON response
  marking, and both SDKs' real notification/transport behavior.
- Current local membership removal, Connect membership removal, public and
  direct-to-core revocation denial, and non-revival after membership restoration,
  tunnel deletion/restoration or registration key replacement/restoration.
- Separate direct tests preserve independent OAuth/GitHub refresh, reject CIMD
  malformed arrays/preferences, support plural/legacy/omitted public-method
  metadata, and reject assertions, code-scope overrides and refresh escalation.
  The browser test selects read-only access and rejects forged consent escalation.

The first paired run exposed an additional real incompatibility: empty legacy
202 notifications lacked a content type and became an incompatible body stream
at the gateway. Core now marks them JSON; the final paired test passes unchanged
routing code. No routing implementation change is needed for this pinned gate.
The exact documentation follow-up for root to dispatch is recorded at the end
of [the contract](mcp-connect-contract.md).

This evidence is local integration, not Cloudflare runtime/deployment, real
GitHub login, live host OAuth, real provider/Docker execution, or complete chat
coverage. Routing's own Workers-runtime suite and root's independent full-chat
coverage review remain complementary gates. Site PR #90 still needs capability
reconciliation. Attempts to refresh current companion PR metadata with
`gh pr view 180 --repo integry/propr-routing --json number,state,headRefOid,url`
and the corresponding site PR #90 command returned **HTTP 401**; the linked PRs
and pinned routing commit came from the supplied request and local Git objects.
No production configuration was altered; no provider credits were spent; no
real target was merged; no new companion task, PR, commit or deployment was made.

## Full-chat follow-up verification and required CI

The existing `Build & Lint Check` → `Validate Changes` job now builds the shared,
core and CLI dependencies, installs Playwright Chromium, and runs `test:mcp`,
`test:mcp:connect` and `test:mcp:browser`. Any failure fails that existing check.
Tests use isolated temporary SQLite/data directories and outbound fixtures;
they do not configure a production instance. Browser tests fail with an
installation instruction if Chromium is missing. OAuth, policy, both SDK eras,
real workflow handlers, concurrent configuration persistence, review/fix state
transitions, and the actual paired Worker/core integration are exercised.

The routing checkout and harness pin are the merged commit
`1fcf82fd1a843fbdf199d79b8f92843dc74a89e0`, so CI does not require the old PR branch.
For local paired verification:

```sh
npm run test:prepare
npm run test:mcp
MCP_ROUTING_REPOSITORY=/path/to/propr-routing npm run test:mcp:connect
npx playwright install --with-deps chromium
npm run test:mcp:browser
npm run build
npm run typecheck -w @propr/api
```

The new concurrency regression pauses an MCP adapter after loading its snapshot,
lets a second repository/agent mutation persist, then resumes the first and
verifies a conflict plus preservation of the second edit. Workflow regressions
keep the original task completed while the new task advances, exercise queue
uncertainty/failure, and persist posted reviews/F# findings before selecting and
observing a fix. No live agent credits, merges, deployments or permission changes
are part of these tests. Root still owns independent verification and merge.

Local verification of this uncommitted follow-up (2026-09-10): 13 MCP tests,
the paired Connect scenario and Chromium consent test passed without skips;
288 fast unit tests and eight related configuration/review/authorization test
files passed. Full build, API typecheck, changed-code ESLint and workflow
`actionlint` passed. The previous CI correction at `420aad1bf` and Connect
implementation at `6147abc9b` are the base of this worktree. The CodeQL workflow is unchanged; its hosted result must be checked on the system’s
resulting commit (the CodeQL CLI is not installed in this implementation image).
