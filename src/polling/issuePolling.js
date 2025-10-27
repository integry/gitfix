import logger, { generateCorrelationId } from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { handleError } from '../utils/errorHandler.js';
import { issueQueue } from '../queue/taskQueue.js';
import Redis from 'ioredis';
import { resolveModelAlias, getDefaultModel } from '../config/modelAliases.js';
import { fetchIssuesForRepo, pollForPullRequestComments } from './repositoryPolling.js';

// Create Redis client for activity logging
const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

/**
 * Polls all configured repositories for issues that need processing
 * @param {Array<string>} repos - List of repository full names to poll
 * @param {Array<string>} githubUserWhitelist - List of allowed GitHub users
 * @param {string} prLabel - Label to filter PRs by
 * @returns {Promise<Array>} Array of detected issues
 */
export async function pollForIssues(repos, githubUserWhitelist = [], prLabel = null) {
    const correlationId = generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    correlatedLogger.info('Starting GitHub issue polling cycle...');
    
    let octokit;
    try {
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );
    } catch (authError) {
        handleError(authError, 'Failed to get authenticated Octokit instance', { correlationId });
        return [];
    }

    const allDetectedIssues = [];
    
    // Poll each configured repository
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
                    
                    // Create separate jobs for each target model
                    for (const modelName of issue.targetModels) {
                        correlatedLogger.info({ 
                            issueId: issue.id, 
                            issueNumber: issue.number, 
                            repository: repoFullName,
                            modelName: modelName
                        }, `Enqueueing job for model: ${modelName}`);
                        
                        try {
                            // Include timestamp in jobId to allow reprocessing after AI-done label removal
                            const timestamp = Date.now();
                            const jobId = `issue-${issue.repoOwner}-${issue.repoName}-${issue.number}-${modelName}-${timestamp}`;
                            const issueJob = {
                                repoOwner: issue.repoOwner,
                                repoName: issue.repoName,
                                number: issue.number,
                                modelName: modelName,
                                correlationId: generateCorrelationId() // Each job gets its own correlation ID
                            };
                            
                            const addToQueueWithRetry = () => withRetry(
                                () => issueQueue.add('processGitHubIssue', issueJob, {
                                    jobId,
                                    // Allow reprocessing by using unique jobId with timestamp
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
                            
                            // Log activity for dashboard
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
                                await redisClient.ltrim('system:activity:log', 0, 999); // Keep last 1000 activities
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
                            // Since we now use unique jobIds with timestamps, this error should not occur
                            // Log any queue errors that do occur
                            handleError(error, `Failed to add issue ${issue.number} with model ${modelName} to queue`, { 
                                correlationId 
                            });
                        }
                    }
                    
                    allDetectedIssues.push(issue);
                }
            }
            
            // Poll for PR comments after processing issues
            await pollForPullRequestComments(octokit, repoFullName, correlationId, githubUserWhitelist, prLabel);
            
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

// Clean up Redis connection on shutdown
export async function closePollingConnections() {
    await redisClient.quit();
}