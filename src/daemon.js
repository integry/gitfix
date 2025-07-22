import 'dotenv/config';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import logger, { generateCorrelationId } from './utils/logger.js';
import { withErrorHandling, handleError } from './utils/errorHandler.js';
import { withRetry, retryConfigs } from './utils/retryHandler.js';
import { issueQueue, shutdownQueue } from './queue/taskQueue.js';
import Redis from 'ioredis';
import { resolveModelAlias, getDefaultModel } from './config/modelAliases.js';

// Configuration from environment variables
const GITHUB_REPOS_TO_MONITOR = process.env.GITHUB_REPOS_TO_MONITOR;
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10);
const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_EXCLUDE_TAGS_PROCESSING = process.env.AI_EXCLUDE_TAGS_PROCESSING || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

// New environment variables for PR comment monitoring
const GITHUB_BOT_USERNAME = process.env.GITHUB_BOT_USERNAME;
const GITHUB_USER_WHITELIST = (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u);
const GITHUB_USER_BLACKLIST = (process.env.GITHUB_USER_BLACKLIST || '').split(',').filter(u => u);

// Parse repositories list
const getRepos = () => {
    if (!GITHUB_REPOS_TO_MONITOR) {
        return [];
    }
    return GITHUB_REPOS_TO_MONITOR.split(',').map(r => r.trim()).filter(r => r);
};

/**
 * Fetches issues for a specific repository based on configured criteria
 * @param {import('@octokit/core').Octokit} octokit - Authenticated Octokit instance
 * @param {string} repoFullName - Repository in format "owner/repo"
 * @param {string} correlationId - Correlation ID for tracking
 * @returns {Promise<Array>} Array of filtered issues
 */
async function fetchIssuesForRepo(octokit, repoFullName, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');
    
    if (!owner || !repo) {
        correlatedLogger.warn({ repo: repoFullName }, 'Invalid repository format. Skipping.');
        return [];
    }

    // Build exclusion labels query
    const excludeLabelsQuery = [AI_EXCLUDE_TAGS_PROCESSING, AI_DONE_TAG]
        .map(tag => `-label:"${tag}"`)
        .join(' ');

    // Construct GitHub search query
    const query = `repo:${owner}/${repo} is:issue is:open label:"${AI_PRIMARY_TAG}" ${excludeLabelsQuery}`;
    correlatedLogger.debug({ repo: repoFullName, query }, 'Constructed search query');

    // Use retry wrapper for GitHub API calls
    const fetchWithRetry = () => withRetry(
        async () => {
            const response = await octokit.request('GET /search/issues', {
                q: query,
                per_page: 100, // Get up to 100 issues per request
                sort: 'created',
                order: 'desc'
            });
            return response;
        },
        { ...retryConfigs.githubApi, correlationId },
        `fetch_issues_${repoFullName}`
    );

    try {
        const response = await fetchWithRetry();

        correlatedLogger.info({ 
            repo: repoFullName, 
            count: response.data.total_count 
        }, `Found ${response.data.total_count} matching issues.`);

        // Transform issues to a simplified format
        return response.data.items.map(issue => {
            const identifiedModels = [];
            const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
            
            for (const label of issue.labels) {
                const match = label.name.match(modelLabelRegex);
                if (match && match[1]) {
                    // Resolve model alias to full model ID
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

        // Check for rate limit errors
        if (error.status === 403 && error.message && error.message.includes('rate limit')) {
            correlatedLogger.warn('GitHub API rate limit likely exceeded. Consider increasing polling interval.');
        }
        
        return [];
    }
}

/**
 * Fetches and processes comments on open pull requests for a repository
 * @param {import('@octokit/core').Octokit} octokit - Authenticated Octokit instance
 * @param {string} repoFullName - Repository in format "owner/repo"
 * @param {string} correlationId - Correlation ID for tracking
 */
async function pollForPullRequestComments(octokit, repoFullName, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');

    try {
        const prs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            state: 'open',
            per_page: 100,
        });

        for (const pr of prs.data) {
            const comments = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner,
                repo,
                issue_number: pr.number,
            });

            for (const comment of comments.data) {
                const commentAuthor = comment.user.login;
                if (comment.body && comment.body.includes('!gitfix')) {
                    // 1. Check if author is the bot
                    if (GITHUB_BOT_USERNAME && commentAuthor === GITHUB_BOT_USERNAME) {
                        continue;
                    }

                    // 2. Check blacklist
                    if (GITHUB_USER_BLACKLIST.length > 0 && GITHUB_USER_BLACKLIST.includes(commentAuthor)) {
                        continue;
                    }

                    // 3. Check whitelist
                    if (GITHUB_USER_WHITELIST.length > 0 && !GITHUB_USER_WHITELIST.includes(commentAuthor)) {
                        continue;
                    }

                    const llmMatch = comment.body.match(/!gitfix:(\w+)/);
                    const llm = llmMatch ? resolveModelAlias(llmMatch[1]) : null;

                    const jobData = {
                        pullRequestNumber: pr.number,
                        commentId: comment.id,
                        commentBody: comment.body,
                        commentAuthor,
                        repoOwner: owner,
                        repoName: repo,
                        branchName: pr.head.ref,
                        llm,
                        correlationId: generateCorrelationId(),
                    };

                    const jobId = `pr-comment-${owner}-${repo}-${pr.number}-${comment.id}`;

                    try {
                        await issueQueue.add('processPullRequestComment', jobData, { jobId });
                        correlatedLogger.info({
                            jobId,
                            pullRequestNumber: pr.number,
                            commentId: comment.id,
                        }, 'Successfully added PR comment to processing queue');
                    } catch (error) {
                        if (error.message?.includes('Job already exists')) {
                            correlatedLogger.debug({
                                pullRequestNumber: pr.number,
                                commentId: comment.id,
                            }, 'PR comment job already in queue, skipping');
                        } else {
                            handleError(error, `Failed to add PR comment ${comment.id} to queue`, { correlationId });
                        }
                    }
                }
            }
        }
    } catch (error) {
        handleError(error, `Error polling PR comments for repository ${repoFullName}`, { correlationId });
    }
}

/**
 * Main polling function that checks all configured repositories for issues
 */
async function pollForIssues() {
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
        return;
    }

    const allDetectedIssues = [];
    const repos = getRepos();
    
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
            await pollForPullRequestComments(octokit, repoFullName, correlationId);
            
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

/**
 * Clears all queue data from Redis
 */
async function resetQueues() {
    logger.info('Resetting all queue data...');
    
    try {
        // Create Redis connection with same config as queue
        const redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });

        // Get all keys related to our queue
        const queueName = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
        const keys = await redis.keys(`bull:${queueName}:*`);
        
        if (keys.length > 0) {
            logger.info({
                queueName,
                keysCount: keys.length
            }, 'Found queue keys to delete');
            
            // Delete all queue-related keys
            await redis.del(...keys);
            
            logger.info({
                queueName,
                deletedKeys: keys.length
            }, 'Successfully cleared all queue data');
        } else {
            logger.info({ queueName }, 'No queue data found to clear');
        }
        
        // Clean up Redis connection
        await redis.quit();
        
    } catch (error) {
        handleError(error, 'Failed to reset queues');
        throw error;
    }
}

/**
 * Removes processing tags from GitHub issues to allow reprocessing
 */
async function resetIssueLabels() {
    logger.info('Resetting issue labels...');
    
    const repos = getRepos();
    if (repos.length === 0) {
        logger.warn('No repositories configured for label reset');
        return;
    }

    try {
        const octokit = await getAuthenticatedOctokit();
        let totalReset = 0;

        for (const repoFullName of repos) {
            const [owner, repo] = repoFullName.split('/');
            if (!owner || !repo) continue;

            logger.info({ repository: repoFullName }, 'Checking for issues with processing labels...');

            try {
                // Search for issues with ONLY processing labels (never remove AI-done labels!)
                const searchQuery = `repo:${repoFullName} is:issue is:open label:"${AI_EXCLUDE_TAGS_PROCESSING}"`;
                
                const searchResponse = await octokit.request('GET /search/issues', {
                    q: searchQuery,
                    per_page: 100
                });

                for (const issue of searchResponse.data.items) {
                    const labelsToRemove = [];
                    const currentLabels = issue.labels.map(label => label.name);
                    
                    // ONLY remove AI-processing labels, NEVER remove AI-done labels
                    if (currentLabels.includes(AI_EXCLUDE_TAGS_PROCESSING)) {
                        labelsToRemove.push(AI_EXCLUDE_TAGS_PROCESSING);
                    }
                    // Removed AI_DONE_TAG removal - completed issues should keep their AI-done labels

                    if (labelsToRemove.length > 0) {
                        logger.info({
                            repository: repoFullName,
                            issueNumber: issue.number,
                            labelsToRemove
                        }, 'Removing AI-processing labels from issue (preserving AI-done labels)');

                        for (const label of labelsToRemove) {
                            await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                                owner,
                                repo,
                                issue_number: issue.number,
                                name: label
                            });
                        }
                        totalReset++;
                    }
                }

                logger.info({
                    repository: repoFullName,
                    issuesFound: searchResponse.data.items.length
                }, 'Processed repository for label reset');

            } catch (repoError) {
                logger.error({
                    repository: repoFullName,
                    error: repoError.message
                }, 'Failed to reset labels for repository');
            }
        }

        logger.info({
            totalIssuesReset: totalReset,
            repositoriesProcessed: repos.length
        }, 'Completed issue label reset');

    } catch (error) {
        handleError(error, 'Failed to reset issue labels');
        throw error;
    }
}

/**
 * Starts the daemon with configured polling interval
 */
async function startDaemon(options = {}) {
    const repos = getRepos();
    
    // Validate required configuration
    if (repos.length === 0) {
        logger.error('GITHUB_REPOS_TO_MONITOR environment variable is not set or empty. Exiting.');
        process.exit(1);
    }
    
    // Handle reset flag
    if (options.reset) {
        logger.info('Reset flag detected, clearing all queue data and issue labels...');
        
        try {
            await resetQueues();
            await resetIssueLabels();
            logger.info('Reset completed successfully');
        } catch (error) {
            logger.error({ error: error.message }, 'Reset failed');
            process.exit(1);
        }
    }
    
    logger.info({
        repositories: repos,
        pollingInterval: POLLING_INTERVAL_MS,
        primaryTag: AI_PRIMARY_TAG,
        excludeProcessingTag: AI_EXCLUDE_TAGS_PROCESSING,
        excludeDoneTag: AI_DONE_TAG,
        modelLabelPattern: MODEL_LABEL_PATTERN,
        defaultModelName: DEFAULT_MODEL_NAME,
        botUsername: GITHUB_BOT_USERNAME || 'not configured',
        userWhitelist: GITHUB_USER_WHITELIST.length > 0 ? GITHUB_USER_WHITELIST : 'all users allowed',
        userBlacklist: GITHUB_USER_BLACKLIST.length > 0 ? GITHUB_USER_BLACKLIST : 'no users blocked',
        resetPerformed: !!options.reset
    }, 'GitHub Issue Detection Daemon starting...');

    // Initial poll
    const safePoll = withErrorHandling(pollForIssues, 'daemon polling');
    safePoll();

    // Set up recurring polling
    const intervalId = setInterval(safePoll, POLLING_INTERVAL_MS);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Received SIGINT, shutting down gracefully...');
        clearInterval(intervalId);
        await shutdownQueue();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM, shutting down gracefully...');
        clearInterval(intervalId);
        await shutdownQueue();
        process.exit(0);
    });
}

// Export functions for testing
export { fetchIssuesForRepo, pollForIssues, pollForPullRequestComments, startDaemon, resetQueues, resetIssueLabels };

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {};
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--reset' || arg === '-r') {
            options.reset = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
GitHub Issue Detection Daemon

Usage: node src/daemon.js [options]

Options:
  --reset, -r    Clear all queue data and remove processing labels from issues
  --help, -h     Show this help message

Environment Variables:
  GITHUB_REPOS_TO_MONITOR    Comma-separated list of repositories to monitor
  POLLING_INTERVAL_MS        Polling interval in milliseconds (default: 60000)
  AI_PRIMARY_TAG             Primary tag to look for (default: AI)
  AI_EXCLUDE_TAGS_PROCESSING Processing tag to exclude (default: AI-processing)
  AI_DONE_TAG                Done tag to exclude (default: AI-done)
  MODEL_LABEL_PATTERN        Regex pattern for model labels (default: ^llm-claude-(.+)$)
  DEFAULT_CLAUDE_MODEL       Default model when no model labels found (default: claude-3-5-sonnet-20240620)
  GITHUB_BOT_USERNAME        Bot username to exclude from PR comment monitoring
  GITHUB_USER_WHITELIST      Comma-separated list of allowed users for PR comments
  GITHUB_USER_BLACKLIST      Comma-separated list of excluded users for PR comments

Examples:
  node src/daemon.js                Start the daemon normally
  node src/daemon.js --reset        Reset all queues and issue labels, then start
  npm run daemon:dev -- --reset     Reset using npm script
            `);
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${arg}`);
            console.error('Use --help for usage information');
            process.exit(1);
        }
    }
    
    return options;
}

// Start daemon if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArgs();
    startDaemon(options).catch(error => {
        logger.error({ error: error.message }, 'Daemon startup failed');
        process.exit(1);
    });
}