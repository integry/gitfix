import { addConfigurationTools } from './toolsConfiguration.js';
import { configRevision } from '../routes/configRevision.js';
import { z } from 'zod';
import { loadMonitoredReposRaw } from '@propr/core';
import { NOTIFICATION_KINDS, REASONING_LEVELS } from '@propr/shared';
import { createUserRepoPreferencesRoutes } from '../routes/userRepoPreferencesRoutes.js';
import type { createRepoTodoRoutes } from '../routes/repoTodoRoutes.js';
import type { createNotificationRoutes } from '../routes/notificationRoutes.js';
import type { createConfigRoutes } from '../routes/configRoutes.js';
import type { createAgentRuntimeRoutes } from '../routes/agentRuntimeRoutes.js';
import { callWorkflow } from './adapter.js';
import { McpError } from './config.js';
import { type McpTool, type ToolDeps, mutationShape, pageShape, repositorySchema, textSchema, idSchema, ok, workflow } from './tools.js';

interface Handlers {
  todos: ReturnType<typeof createRepoTodoRoutes>;
  notifications: ReturnType<typeof createNotificationRoutes>;
  config: ReturnType<typeof createConfigRoutes>;
  runtime: ReturnType<typeof createAgentRuntimeRoutes>;
}

export function addManagementTools(tools: McpTool[], deps: ToolDeps, { todos, notifications, config, runtime }: Handlers): void {
  const { db } = deps;
  const todoTarget = { table: 'repo_todos', column: 'todo_id', arg: 'todoId', owner: 'user_id' };
  const categoryTarget = { table: 'repo_todo_categories', column: 'category_id', arg: 'categoryId', owner: 'user_id' };
  for (const [name, table] of [['list_todos', 'repo_todos'], ['list_todo_categories', 'repo_todo_categories']] as const) tools.push({ name, description: 'List your repository TODO items or categories.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema, ...pageShape }).strict(), run: async ({ principal, args }) => {
    const items = await db(table).where({ repository: args.repository, user_id: principal.user.id }).orderBy('order_index').orderBy('id').offset(args.offset).limit(args.limit);
    return ok({ items, nextOffset: items.length === args.limit ? args.offset + args.limit : null });
  } });
  workflow(tools, { name: 'get_todo', description: 'Read one of your TODOs.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema, todoId: z.uuid() }).strict(), target: todoTarget }, todos.getTodo, args => ({ params: { todoId: args.todoId } }));
  workflow(tools, { name: 'create_todo', description: 'Create a repository TODO without starting work.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema, content: textSchema }).strict() }, todos.createTodo, args => ({ body: { repository: args.repository, content: args.content } }));
  workflow(tools, { name: 'update_todo', description: 'Edit or complete one of your repository TODOs.', scope: 'plan', target: todoTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, todoId: z.uuid(), content: textSchema.optional(), isCompleted: z.boolean().optional(), orderIndex: z.number().int().min(0).optional() }).strict() }, todos.updateTodo, args => ({ params: { todoId: args.todoId }, body: { content: args.content, isCompleted: args.isCompleted, orderIndex: args.orderIndex } }));
  workflow(tools, { name: 'delete_todo', description: 'Delete your TODO.', scope: 'plan', target: todoTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, todoId: z.uuid() }).strict() }, todos.deleteTodo, args => ({ params: { todoId: args.todoId } }));
  workflow(tools, { name: 'create_todo_category', description: 'Create a TODO category.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema, name: z.string().min(1).max(255), orderIndex: z.number().int().min(0).optional() }).strict() }, todos.createCategory, args => ({ body: args }));
  workflow(tools, { name: 'update_todo_category', description: 'Rename or reorder your TODO category.', scope: 'plan', target: categoryTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, categoryId: z.uuid(), name: z.string().min(1).max(255).optional(), orderIndex: z.number().int().min(0).optional() }).strict() }, todos.updateCategory, args => ({ params: { categoryId: args.categoryId }, body: { name: args.name, orderIndex: args.orderIndex } }));
  workflow(tools, { name: 'delete_todo_category', description: 'Delete your TODO category using the existing product semantics.', scope: 'plan', target: categoryTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, categoryId: z.uuid() }).strict() }, todos.deleteCategory, args => ({ params: { categoryId: args.categoryId } }));
  tools.push({ name: 'move_todo', description: 'Move your TODO into an owned category in the same repository, or uncategorize it.', scope: 'plan', target: todoTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, todoId: z.uuid(), categoryId: z.uuid().nullable(), orderIndex: z.number().int().min(0).default(0) }).strict(), run: async ({ principal, args }) => {
    if (args.categoryId && !await db('repo_todo_categories').where({ category_id: args.categoryId, user_id: principal.user.id, repository: args.repository }).first()) throw new McpError('NOT_FOUND', 'Category not found in this repository.', 404);
    return callWorkflow(todos.updateTodo, principal, { params: { todoId: args.todoId }, body: { categoryId: args.categoryId, orderIndex: args.orderIndex } });
  } });
  const preferences = createUserRepoPreferencesRoutes();
  tools.push({ name: 'get_repository_preferences', description: 'Read your star/hidden preferences for a repository.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema }).strict(), run: async ({ principal, args }) => {
    const response = await callWorkflow(preferences.getRepoPreferences, principal, {});
    return ok({ repository: args.repository, preferences: (response.data as { preferences: Record<string, unknown> }).preferences[args.repository] || {} });
  } });
  tools.push({ name: 'update_repository_preferences', description: 'Change your repository star/hidden preferences.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema, starred: z.boolean().optional(), hidden: z.boolean().optional() }).strict(), run: async ({ principal, args }) => {
    await callWorkflow(preferences.updateRepoPreferences, principal, { body: { preferences: { [args.repository]: { starred: args.starred, hidden: args.hidden } } } });
    return ok({ repository: args.repository, updated: true });
  } });

  tools.push({ name: 'list_notifications', description: 'Read your notifications limited to an authorized repository.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema, cursor: z.string().max(512).optional(), limit: z.number().int().min(1).max(100).default(20) }).strict(), run: async ({ principal, args }) => {
    const response = await callWorkflow(notifications.getNotifications, principal, { query: { cursor: args.cursor, limit: String(args.limit) } });
    const data = response.data as { notifications: Array<{ target: { repository?: string } }>; nextCursor: string | null };
    return ok({ notifications: data.notifications.filter(notification => notification.target.repository === args.repository), nextCursor: data.nextCursor });
  } });
  for (const action of ['read', 'dismiss'] as const) tools.push({ name: action === 'read' ? 'mark_notification_read' : 'dismiss_notification', description: `${action} one of your repository notifications.`, scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema, notificationId: idSchema }).strict(), run: async ({ principal, args }) => {
    const row = await db('notification_events').where({ event_id: args.notificationId }).first('target_json');
    if (!row || JSON.parse(row.target_json).repository !== args.repository) throw new McpError('NOT_FOUND', 'Notification not found.', 404);
    const response = await callWorkflow(action === 'read' ? notifications.markRead : notifications.dismiss, principal, { params: { id: args.notificationId } });
    return ok({ notification: (response.data as { notification: unknown }).notification });
  } });
  workflow(tools, { name: 'get_notification_preferences', description: 'Read your notification preferences.', scope: 'read', readOnly: true, schema: z.object({}).strict() }, notifications.getPreferences, () => ({}));
  workflow(tools, { name: 'set_notification_category_preferences', description: 'Enable or disable inbox and push delivery for a notification category. Browser push subscription requires browser setup.', scope: 'plan', schema: z.object({ ...mutationShape, category: z.enum(NOTIFICATION_KINDS), inboxEnabled: z.boolean().optional(), pushEnabled: z.boolean().optional() }).strict() }, notifications.updatePreferences, args => ({ body: { preferences: { [args.category]: { inboxEnabled: args.inboxEnabled, pushEnabled: args.pushEnabled } } } }));
  workflow(tools, { name: 'update_notification_preferences', description: 'Update your badge and quiet-hours preferences. Null start/end clears quiet hours.', scope: 'plan', schema: z.object({ ...mutationShape, badgeEnabled: z.boolean().optional(), quietHours: z.object({ start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(), end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(), timezone: z.string().max(100).optional() }).strict().optional() }).strict() }, notifications.updatePreferences, args => ({ body: { badgeEnabled: args.badgeEnabled, quietHours: args.quietHours } }));
  tools.push({ name: 'update_notifications', description: 'Read or dismiss an explicit bounded set of your notifications in one authorized repository.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema, notificationIds: z.array(idSchema).min(1).max(100), action: z.enum(['read', 'dismiss']) }).strict(), run: async ({ principal, args }) => {
    const ids = [...new Set<string>(args.notificationIds)];
    const rows = await db('notification_events').whereIn('event_id', ids).select('event_id', 'target_json');
    if (rows.length !== ids.length || rows.some(row => JSON.parse(row.target_json).repository !== args.repository)) throw new McpError('NOT_FOUND', 'One or more notifications are outside this repository.', 404);
    for (const id of ids) await callWorkflow(args.action === 'read' ? notifications.markRead : notifications.dismiss, principal, { params: { id } });
    return ok({ action: args.action, notificationIds: ids });
  } });

  const settingsShape = { worker_concurrency: z.number().int().min(1).max(100).optional(), analysis_model_fast: z.string().max(256).optional(), planner_context_model: z.string().max(256).optional(), pr_review_prompt: z.string().max(65536).optional(), pr_review_context_enabled: z.boolean().optional(), pr_review_context_model: z.string().max(256).optional(), pr_review_max_context_tokens: z.union([z.literal(0), z.number().int().min(10000).max(2000000)]).optional(), default_agent_alias: idSchema.optional(), planner_generation_model: idSchema.optional(), model_reasoning_level: z.enum(REASONING_LEVELS).optional(), pr_review_model: z.string().max(256).optional(), ultrafix_rating_goal: z.number().int().min(1).max(10).optional(), ultrafix_max_cycles: z.number().int().min(1).max(10).optional(), ultrafix_pause_seconds: z.number().int().min(0).max(3600).optional(), auto_followup_score_threshold: z.number().int().min(0).max(9).optional(), auto_resolve_merge_conflicts: z.boolean().optional() };
  tools.push({ name: 'get_execution_settings', description: 'Read supported execution/model settings without secrets.', scope: 'read', readOnly: true, schema: z.object({}).strict(), run: async ({ principal }) => {
    const settings = (await callWorkflow(config.getSettings, principal, {})).data as Record<string, unknown>;
    return ok(Object.fromEntries(Object.keys(settingsShape).filter(key => key in settings).map(key => [key, settings[key]])));
  } });
  workflow(tools, { name: 'update_execution_settings', description: 'Update supported execution/model settings. Requires instance.manage_settings.', scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, settings: z.object(settingsShape).strict() }).strict() }, config.postSettings, args => ({ body: { settings: args.settings } }));
  workflow(tools, { name: 'index_repository', description: 'Queue indexing for an explicit repository and branch through the existing indexing workflow.', scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, repository: repositorySchema, baseBranch: idSchema, fullReindex: z.boolean().default(false), ignoreCooldown: z.boolean().default(false) }).strict() }, config.triggerIndexing, args => ({ body: { repository: args.repository, baseBranch: args.baseBranch, fullReindex: args.fullReindex, ignoreCooldown: args.ignoreCooldown } }));
  workflow(tools, { name: 'stop_repository_indexing', description: 'Request cancellation of indexing for an explicit repository and branch.', scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, repository: repositorySchema, branch: idSchema }).strict() }, config.stopIndexing, args => ({ body: { repository: args.repository, branch: args.branch } }));
  workflow(tools, { name: 'get_runtime_configuration', description: 'Read supported agent runtime packages and build state.', scope: 'manage', permission: 'instance.manage_runtime', readOnly: true, schema: z.object({}).strict() }, runtime.getRuntimePackages, () => ({}));
  workflow(tools, { name: 'update_runtime_configuration', description: 'Apply validated runtime packages through the existing runtime builder.', scope: 'manage', permission: 'instance.manage_runtime', schema: z.object({ ...mutationShape, packages: z.array(z.string().min(1).max(200)).max(100) }).strict() }, runtime.putRuntimePackages, args => ({ body: { packages: args.packages } }));
  tools.push({ name: 'get_repository_configuration', description: 'Read a configured repository’s non-secret operational settings.', scope: 'manage', permission: 'instance.manage_settings', readOnly: true, schema: z.object({ repository: repositorySchema }).strict(), run: async ({ args }) => {
    const repo = (await loadMonitoredReposRaw()).find(repo => repo.name.toLowerCase() === args.repository.toLowerCase());
    if (!repo) throw new McpError('NOT_FOUND', 'Configured repository no longer exists.', 404);
    return ok(repo);
  } });
  tools.push({ name: 'update_repository_configuration', description: 'Update branch, alias, enabled state, CI followup or visual preview policy for a specific configured repository.', scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, repository: repositorySchema, baseBranch: idSchema.optional(), alias: idSchema.optional(), enabled: z.boolean().optional(), autoFollowupOnFailedCi: z.boolean().optional(), visualPreview: z.object({ enabled: z.boolean(), types: z.array(z.enum(['image', 'video'])).min(1).max(2), instructions: z.string().max(8192).optional() }).strict().optional() }).strict(), run: async ({ principal, args }) => {
    const repos = await loadMonitoredReposRaw();
    const patch = Object.fromEntries(['baseBranch', 'alias', 'enabled', 'autoFollowupOnFailedCi', 'visualPreview'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    const updated = repos.map(repo => repo.name.toLowerCase() === args.repository.toLowerCase() ? { ...repo, ...patch } : repo);
    await callWorkflow(config.postRepos, principal, { body: { repos_to_monitor: updated, expectedRevision: configRevision(repos) } });
    return ok({ repository: args.repository, updated: true });
  } });
  addConfigurationTools(tools, deps, config);
}
