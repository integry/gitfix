# MCP capability coverage and acceptance checklist

The executable catalog is `packages/api/mcp/tools.ts` and its `tools*.ts`
modules. `tools/list` filters capabilities by the authenticated grant and
current administrator permissions. All listed tools have implementations;
there is no generic REST or shell execution tool.

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
| PR read/review/fix/ultrafix | `get_pull_request`, `review_pull_request`, `fix_review_findings`, `run_ultrafix` |
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
| Repository configuration | `get_repository_configuration`, `update_repository_configuration` (branch/alias/enabled/CI followup/visual preview policy) |
| Existing agent configuration | `update_agent_configuration` (enabled/default model); catalogs for reads |
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
- [x] Browser consent with repository selection, CSRF protection, connected
  apps and revocation; Chromium desktop/mobile behavior and image evidence.
- [x] Opt-in signed Connect delegation, audience/instance/installation/user
  binding, current introspection restrictions, separate GitHub credentials.
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
- [x] Real ES256/JWKS delegation fixture checks current introspection,
  wrong bindings, missing separate credentials, allowlist revocation and
  absence of forwarded client/GitHub tokens.
- [x] SQLite file reopen and concurrent durable dedup test.
- [x] Browser consent/revocation test, CSRF denial and mobile overflow check.
- [ ] A live end-to-end agent run through generation → publication →
  implementation → followup → review/fix → guarded merge. Local tests do not
  provision Docker agents, spend provider credits or merge real PRs.
- [ ] Live GitHub login, ChatGPT/Claude OAuth and host voice sessions.
- [ ] Routing/site companion implementations and linked companion PRs.
- [ ] Live tunnel unavailability/version mismatch/cancellation/streaming
  verification against the deployed gateway. The expected mapping is in
  `mcp-connect-contract.md`; the gateway is not part of this checkout.

Setup that enters provider credentials or extends configured repositories and
grant restrictions stays in browser settings and OAuth consent. Existing agent
enabled/default-model changes are supported; agent creation, provider login,
synthetic-agent composition and advanced global indexing/provider policy still
use their existing settings flows. Raw Docker streaming logs are not exposed;
bounded persisted execution events are available through `get_task_logs`.
The tools above cover their named workflows; this document does not label the
entire epic's live or cross-repository acceptance as complete.

Uncertain external side effects remain `unknown` and require inspecting the
target. They are never reported as rolled back or blindly retried. In
particular, a partly published plan remains busy with persisted created issue
links. Cancelling a receipt cannot undo already published issues or comments.
