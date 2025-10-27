import logger, { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { resolveModelAlias, getDefaultModel } from '../config/modelAliases.js';
import { issueQueue } from '../queue/taskQueue.js';
import Redis from 'ioredis';

const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_EXCLUDE_TAGS_PROCESSING = process.env.AI_EXCLUDE_TAGS_PROCESSING || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

export async function fetchIssuesForRepo(octokit, repoFullName, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');
    
    if (!owner || !repo) {
        correlatedLogger.warn({ repo: repoFullName }, 'Invalid repository format. Skipping.');
        return [];
    }

    const fetchWithRetry = () => withRetry(
        async () => {
            const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
                owner,
                repo,
                state: 'open',
                labels: AI_PRIMARY_TAG,
                per_page: 100,
                sort: 'created',
                direction: 'desc'
            });
            
            const filteredIssues = issues.filter(issue => {
                const labelNames = issue.labels.map(label => 
                    typeof label === 'string' ? label : label.name
                );
                return !labelNames.includes(AI_EXCLUDE_TAGS_PROCESSING) && 
                       !labelNames.includes(AI_DONE_TAG);
            });
            
            correlatedLogger.debug({ 
                repo: repoFullName, 
                totalIssues: issues.length,
                filteredIssues: filteredIssues.length,
                excludedLabels: [AI_EXCLUDE_TAGS_PROCESSING, AI_DONE_TAG]
            }, 'Filtered issues by labels');
            
            return { data: { items: filteredIssues } };
        },
        { ...retryConfigs.githubApi, correlationId },
        `fetch_issues_${repoFullName}`
    );

    try {
        const response = await fetchWithRetry();

        correlatedLogger.info({ 
            repo: repoFullName, 
            count: response.data.items.length 
        }, `Found ${response.data.items.length} matching issues.`);

        return response.data.items.map(issue => {
            const identifiedModels = [];
            const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
            
            for (const label of issue.labels) {
                const match = label.name.match(modelLabelRegex);
                if (match && match[1]) {
                    const resolvedModel = resolveModelAlias(match[1]);
                    identifiedModels.push(resolvedModel);
                }
            }
            
            return {
                id: issue.id,
                number: issue.number,
                title: issue.title,
                url: issue.html_url,
                repoOwner: owner,
                repoName: repo,
                labels: issue.labels.map(l => l.name),
                targetModels: identifiedModels.length > 0 ? identifiedModels : [DEFAULT_MODEL_NAME],
                createdAt: issue.created_at,
                updatedAt: issue.updated_at
            };
        });
    } catch (error) {
        handleError(error, `fetch_issues_${repoFullName}`, { correlationId });

        if (error.status === 403 && error.message && error.message.includes('rate limit')) {
            correlatedLogger.warn('GitHub API rate limit likely exceeded. Consider increasing polling interval.');
        }
        
        return [];
    }
}

export async function pollForIssues(octokit, repos) {
    const correlationId = generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    correlatedLogger.info('Starting GitHub issue polling cycle...');
    
    const allDetectedIssues = [];
    
    for (const repoFullName of repos) {
        correlatedLogger.debug({ repository: repoFullName }, 'Polling repository');
        
        try {
            const issues = await fetchIssuesForRepo(octokit, repoFullName, correlationId);
            
            if (issues.length > 0) {
                for (const issue of issues) {
                    correlatedLogger.info({ 
                        issueId: issue.id, 
                        issueNumber: issue.number, 
                        issueTitle: issue.title, 
                        issueUrl: issue.url,
                        repository: repoFullName,
                        targetModels: issue.targetModels
                    }, 'Detected eligible issue');
                    
                    for (const modelName of issue.targetModels) {
                        correlatedLogger.info({ 
                            issueId: issue.id, 
                            issueNumber: issue.number, 
                            repository: repoFullName,
                            modelName: modelName
                        }, `Enqueueing job for model: ${modelName}`);
                        
                        try {
                            const timestamp = Date.now();
                            const jobId = `issue-${issue.repoOwner}-${issue.repoName}-${issue.number}-${modelName}-${timestamp}`;
                            const issueJob = {
                                repoOwner: issue.repoOwner,
                                repoName: issue.repoName,
                                number: issue.number,
                                modelName: modelName,
                                correlationId: generateCorrelationId()
                            };
                            
                            const addToQueueWithRetry = () => withRetry(
                                () => issueQueue.add('processGitHubIssue', issueJob, {
                                    jobId,
                                    attempts: 3,
                                    backoff: {
                                        type: 'exponential',
                                        delay: 2000,
                                    },
                                }),
                                { ...retryConfigs.redis, correlationId },
                                `add_issue_to_queue_${issue.number}_${modelName}`
                            );
                            
                            await addToQueueWithRetry();
                            
                            try {
                                const activity = {
                                    id: `activity-${timestamp}-${issue.id}-${modelName}`,
                                    type: 'issue_created',
                                    timestamp: new Date().toISOString(),
                                    repository: repoFullName,
                                    issueNumber: issue.number,
                                    description: `New issue #${issue.number} detected for processing with ${modelName}`,
                                    status: 'info'
                                };
                                await redisClient.lpush('system:activity:log', JSON.stringify(activity));
                                await redisClient.ltrim('system:activity:log', 0, 999);
                            } catch (activityError) {
                                correlatedLogger.warn({ error: activityError.message }, 'Failed to log activity');
                            }
                            
                            correlatedLogger.info({ 
                                jobId,
                                issueNumber: issue.number,
                                repository: repoFullName,
                                modelName: modelName,
                                issueCorrelationId: issueJob.correlationId
                            }, 'Successfully added issue-model job to processing queue');
                            
                        } catch (error) {
                            handleError(error, `Failed to add issue ${issue.number} with model ${modelName} to queue`, { 
                                correlationId 
                            });
                        }
                    }
                    
                    allDetectedIssues.push(issue);
                }
            }
            
        } catch (error) {
            handleError(error, `Error polling repository ${repoFullName}`, { correlationId });
        }
    }
    
    correlatedLogger.info({ 
        totalIssues: allDetectedIssues.length,
        repositories: repos.length 
    }, 'Polling cycle completed');
    
    return allDetectedIssues;
}

export async function shutdownPolling() {
    try {
        await redisClient.quit();
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to shutdown polling Redis client');
    }
}
