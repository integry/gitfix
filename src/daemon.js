import 'dotenv/config';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import logger, { generateCorrelationId } from './utils/logger.js';
import { withErrorHandling, handleError } from './utils/errorHandler.js';
import { withRetry, retryConfigs } from './utils/retryHandler.js';
import { issueQueue, shutdownQueue } from './queue/taskQueue.js';
import Redis from 'ioredis';
import { resolveModelAlias, getDefaultModel, getProviderForModel } from './config/modelAliases.js';

// Configuration from environment variables
const GITHUB_REPOS_TO_MONITOR = process.env.GITHUB_REPOS_TO_MONITOR;
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10);
const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_EXCLUDE_TAGS_PROCESSING = process.env.AI_EXCLUDE_TAGS_PROCESSING || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';
// Support multiple provider label patterns
const MODEL_LABEL_PATTERNS = {
    claude: process.env.CLAUDE_LABEL_PATTERN || '^llm-claude-(.+)$',
    openai: process.env.OPENAI_LABEL_PATTERN || '^llm-openai-(.+)$',
    gemini: process.env.GEMINI_LABEL_PATTERN || '^llm-gemini-(.+)$'
};
const LEGACY_MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';
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
            
            // Check all provider patterns and legacy pattern
            const allPatterns = {
                ...MODEL_LABEL_PATTERNS,
                legacy: LEGACY_MODEL_LABEL_PATTERN
            };
            
            for (const label of issue.labels) {
                for (const [providerName, pattern] of Object.entries(allPatterns)) {
                    const modelLabelRegex = new RegExp(pattern);
                    const match = label.name.match(modelLabelRegex);
                    if (match && match[1]) {
                        // Resolve model alias to full model ID
                        const resolvedModel = resolveModelAlias(match[1]);
                        identifiedModels.push(resolvedModel);
                        break; // Found a match, no need to check other patterns for this label
                    }
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

    correlatedLogger.debug({
        repository: repoFullName
    }, 'Checking for PR comments in repository');

    try {
        // Fetch ALL open pull requests using pagination
        const prs = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            state: 'open',
            per_page: 100
        });

        correlatedLogger.debug({
            repository: repoFullName,
            openPRCount: prs.length
        }, `Found ${prs.length} open pull requests`);

        if (prs.length === 0) {
            correlatedLogger.debug({
                repository: repoFullName
            }, 'No open pull requests found, skipping PR comment check');
            return;
        }

        for (const pr of prs) {
            correlatedLogger.debug({
                repository: repoFullName,
                pullRequestNumber: pr.number,
                pullRequestTitle: pr.title
            }, 'Checking PR for comments');

            // Fetch all issue comments and PR review comments with pagination
            // Using Octokit's paginate method to get ALL comments, not just the first page
            const [issueComments, reviewComments] = await Promise.all([
                octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: pr.number,
                    per_page: 100
                }),
                octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
                    owner,
                    repo,
                    pull_number: pr.number,
                    per_page: 100
                })
            ]);

            // Combine both types of comments
            // Note: issueComments and reviewComments are now arrays directly (not .data)
            const allComments = [
                ...issueComments,
                ...reviewComments
            ];

            // Check if any bot comments exist after this comment that indicate processing
            const botUsername = GITHUB_BOT_USERNAME || 'github-actions[bot]';
            const commentsByTime = allComments.sort((a, b) => 
                new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            );

            const gitfixComments = commentsByTime.filter(c => c.body && c.body.includes('!gitfix'));
            
            correlatedLogger.debug({
                repository: repoFullName,
                pullRequestNumber: pr.number,
                issueComments: issueComments.length,
                reviewComments: reviewComments.length,
                totalComments: allComments.length,
                gitfixComments: gitfixComments.length
            }, `Found ${allComments.length} comments (${issueComments.data.length} issue + ${reviewComments.data.length} review), ${gitfixComments.length} with !gitfix`);

            // Log comment details for debugging
            if (allComments.length > 0 && gitfixComments.length === 0) {
                correlatedLogger.debug({
                    repository: repoFullName,
                    pullRequestNumber: pr.number,
                    commentBodies: commentsByTime.map(c => ({
                        id: c.id,
                        author: c.user.login,
                        type: c.pull_request_review_id ? 'review' : 'issue',
                        bodyPreview: c.body ? c.body.substring(0, 100) + (c.body.length > 100 ? '...' : '') : 'null'
                    }))
                }, 'Comment details (no !gitfix found)');
            }

            // Collect all unprocessed !gitfix comments for batch processing
            const unprocessedComments = [];
            let selectedLlm = null;

            for (const comment of commentsByTime) {
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

                    // 4. Check if this comment has already been processed
                    const commentIndex = commentsByTime.indexOf(comment);
                    const subsequentComments = commentsByTime.slice(commentIndex + 1);
                    const alreadyProcessed = subsequentComments.some(laterComment => {
                        const isBotComment = laterComment.user.login === botUsername || 
                                           laterComment.user.type === 'Bot' ||
                                           laterComment.user.login.includes('[bot]');
                        
                        if (!isBotComment) return false;
                        
                        // Check if bot comment references this specific comment
                        return laterComment.body.includes(`Comment ID: ${comment.id}`) ||
                               laterComment.body.includes(`@${commentAuthor}`) && (
                                   laterComment.body.includes('Starting work on follow-up changes') ||
                                   laterComment.body.includes('Applied the requested follow-up changes') ||
                                   laterComment.body.includes('Failed to apply follow-up changes') ||
                                   laterComment.body.includes('Analyzed the follow-up request')
                               );
                    });

                    if (alreadyProcessed) {
                        correlatedLogger.debug({
                            repository: `${owner}/${repo}`,
                            pullRequestNumber: pr.number,
                            commentId: comment.id,
                            commentAuthor,
                            commentType: comment.pull_request_review_id ? 'review' : 'issue'
                        }, 'PR comment already processed, skipping');
                        continue;
                    }

                    const llmMatch = comment.body.match(/!gitfix:(\w+)/);
                    const llm = llmMatch ? resolveModelAlias(llmMatch[1]) : null;
                    
                    // Use the first specified LLM, or fallback to the last one found
                    if (llm && !selectedLlm) {
                        selectedLlm = llm;
                    }

                    // For review comments, include the code context
                    let enhancedCommentBody = comment.body;
                    if (comment.pull_request_review_id) {
                        // This is a PR review comment
                        const codeContext = [];
                        if (comment.path) {
                            codeContext.push(`File: ${comment.path}`);
                        }
                        if (comment.line) {
                            codeContext.push(`Line: ${comment.line}`);
                        }
                        if (comment.diff_hunk) {
                            codeContext.push('Code context:');
                            codeContext.push('```diff');
                            codeContext.push(comment.diff_hunk);
                            codeContext.push('```');
                        }
                        
                        if (codeContext.length > 0) {
                            enhancedCommentBody = `${comment.body}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
                        }
                    }

                    unprocessedComments.push({
                        id: comment.id,
                        body: enhancedCommentBody,
                        author: commentAuthor,
                        type: comment.pull_request_review_id ? 'review' : 'issue',
                        hasCodeContext: comment.pull_request_review_id && comment.diff_hunk ? true : false
                    });
                }
            }

            // If we have unprocessed comments, create a single batch job
            if (unprocessedComments.length > 0) {
                const jobData = {
                    pullRequestNumber: pr.number,
                    comments: unprocessedComments,  // Array of all comments to process
                    repoOwner: owner,
                    repoName: repo,
                    branchName: pr.head.ref,
                    llm: selectedLlm,
                    correlationId: generateCorrelationId(),
                };

                // Create a unique job ID based on PR and timestamp to allow reprocessing
                const timestamp = Date.now();
                const jobId = `pr-comments-batch-${owner}-${repo}-${pr.number}-${timestamp}`;

                try {
                    await issueQueue.add('processPullRequestComment', jobData, { jobId });
                    correlatedLogger.info({
                        jobId,
                        pullRequestNumber: pr.number,
                        commentsCount: unprocessedComments.length,
                        commentIds: unprocessedComments.map(c => c.id),
                        commentTypes: unprocessedComments.map(c => c.type)
                    }, `Successfully added batch PR comments job to processing queue (${unprocessedComments.length} comments)`);
                } catch (error) {
                    if (error.message?.includes('Job already exists')) {
                        correlatedLogger.debug({
                            pullRequestNumber: pr.number,
                            commentsCount: unprocessedComments.length,
                        }, 'PR comments batch job already in queue, skipping');
                    } else {
                        handleError(error, `Failed to add PR comments batch to queue`, { correlationId });
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
    
    // Initialize Redis connection for heartbeat
    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        retryStrategy: times => Math.min(times * 50, 2000)
    });
    
    // Function to send heartbeat
    const sendHeartbeat = async () => {
        try {
            await heartbeatRedis.set('system:status:daemon', Date.now(), 'EX', 90);
            logger.debug('Daemon heartbeat sent');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send daemon heartbeat');
        }
    };
    
    // Send initial heartbeat
    await sendHeartbeat();
    
    // Set up heartbeat interval (every 30 seconds)
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);
    
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
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await shutdownQueue();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM, shutting down gracefully...');
        clearInterval(intervalId);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
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