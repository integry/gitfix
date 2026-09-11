import type { McpConfig } from './config.js';
import type { Args, McpTool } from './tools.js';

interface ResultTargets { planId?: string; goalId?: string; taskId?: string }

function resultLinks(tool: McpTool, args: Args, result: Args, config: Pick<McpConfig, 'instanceId' | 'origin'>): Record<string, string> {
  const continuation = result.continuation || result;
  const planId = args.planId || continuation.planId;
  const goalId = args.goalId || continuation.goalId;
  const taskId = continuation.taskId || args.taskId;
  const { origin, instanceId } = config;
  let resource = 'connection', ui = origin;
  const frontend = (process.env.FRONTEND_URL || origin).replace(/\/$/, '');
  if (planId) { resource = `plans/${encodeURIComponent(planId)}`; ui = `${frontend}/studio/${encodeURIComponent(planId)}`; }
  else if (goalId) { resource = `goals/${encodeURIComponent(goalId)}`; ui = `${frontend}/goals/${encodeURIComponent(goalId)}`; }
  else if (taskId) { resource = `tasks/${encodeURIComponent(taskId)}`; ui = `${frontend}/tasks/${encodeURIComponent(taskId)}`; }
  else if (args.pullRequest) { resource = `repositories/${args.repository}/pulls/${args.pullRequest}`; ui = `https://github.com/${args.repository}/pull/${args.pullRequest}`; }
  else if (args.artifactId || result.artifactId) { const id = args.artifactId || result.artifactId; resource = `artifacts/${id}`; ui = `${origin}/mcp/artifacts/${id}`; }
  else if (tool.name === 'list_repositories') resource = 'repositories';
  else if (tool.name === 'list_models') resource = 'models';
  return { instance: origin, ui, resource: `propr://instances/${instanceId}/${resource}` };
}

function mutationSummary(tool: McpTool, data: Args, result: Args, targets: ResultTargets): string {
  let summary = `${tool.name.replaceAll('_', ' ')}: ${data.state}.`;
  if (data.state === 'accepted') summary += ' Work was accepted; completion is still pending.';
  if (data.state === 'unknown') summary += ' The outcome needs inspection before another action.';
  if (result.error) summary += ` ${result.error.code}: ${result.error.message}`;
  if (targets.planId) summary += ` Plan ${targets.planId}.`;
  if (targets.goalId) summary += ` Goal ${targets.goalId}.`;
  if (targets.taskId) summary += ` Task ${targets.taskId}.`;
  summary += ` Operation ${data.operationId}.`;
  return summary;
}

function readSummary(tool: McpTool, args: Args, result: Args): string {
  if (tool.name === 'get_task') return `Task ${args.taskId}: ${result.latestEvent?.state || 'no execution state yet'}.`;
  if (tool.name === 'get_plan') return `${result.name || 'Plan'}: ${result.status}, revision ${result.mcp_revision}.`;
  if (tool.name === 'get_goal') return `${result.goal?.title || 'Goal'}: ${result.goal?.resultState || result.goal?.desiredState || 'state unavailable'}.`;
  if (tool.name === 'get_connection') return `Connected as ${result.identity.username} to ${result.instanceId}. ${result.scopes.join(', ')} permissions.`;
  if (tool.name === 'resolve_reference') return result.match === 'ambiguous' || result.match === 'candidates' ? `${result.candidates.length} candidates. Choose an exact handle before acting.` : `${result.match.replaceAll('_', ' ')}: ${result.candidates.length} candidates.`;
  const list = Object.values(result).find(Array.isArray);
  return list ? `${tool.name.replaceAll('_', ' ')}: ${list.length} items in this page.` : `${tool.name.replaceAll('_', ' ')}: retrieved.`;
}

/** Small spoken summaries; the structured result remains authoritative. */
export function presentResult(tool: McpTool, args: Args, data: Args, config: Pick<McpConfig, 'instanceId' | 'origin'>): { summary: string; links: Record<string, string> } {
  const result = tool.readOnly && tool.name !== 'get_operation' ? data : data.result || {};
  const continuation = result.continuation || result;
  const targets = { planId: args.planId || continuation.planId, goalId: args.goalId || continuation.goalId, taskId: continuation.taskId || args.taskId };
  const summary = tool.readOnly ? readSummary(tool, args, result) : mutationSummary(tool, data, result, targets);
  return { summary, links: resultLinks(tool, args, result, config) };
}
