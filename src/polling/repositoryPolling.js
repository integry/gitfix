import logger, { generateCorrelationId } from '../utils/logger.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { handleError } from '../utils/errorHandler.js';
import { issueQueue } from '../queue/taskQueue.js';
import { resolveModelAlias, getDefaultModel } from '../config/modelAliases.js';

// Configuration from environment variables
const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_EXCLUDE_TAGS_PROCESSING = process.env.AI_EXCLUDE_TAGS_PROCESSING || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();
const GITHUB_BOT_USERNAME = process.env.GITHUB_BOT_USERNAME;
const GITHUB_USER_BLACKLIST = (process.env.GITHUB_USER_BLACKLIST || '').split(',').filter(u => u);
const PR_FOLLOWUP_TRIGGER_KEYWORDS = (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS !== undefined ? process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS : '').split(',').filter(k => k.trim()).map(k => k.trim());
const PR_LABEL = process.env.PR_LABEL || 'gitfix';

/**
 * Fetches issues from a specific repository that match the criteria
 * @param {import('@octokit/core').Octokit} octokit - Authenticated Octokit instance
 * @param {string} repoFullName - Repository in format "owner/repo"
 * @param {string} correlationId - Correlation ID for tracking
 * @returns {Promise<Array>} Array of issue objects
 */
export async function fetchIssuesForRepo(octokit, repoFullName, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');
    
    if (!owner || !repo) {
        correlatedLogger.warn({ repo: repoFullName }, 'Invalid repository format. Skipping.');
        return [];
    }

    // Use retry wrapper for GitHub API calls
    const fetchWithRetry = () => withRetry(
        async () => {
            // Use the issues API instead of the deprecated search API
            // First, get all open issues with the primary AI tag
            const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
                owner,
                repo,
                state: 'open',
                labels: AI_PRIMARY_TAG,
                per_page: 100,
                sort: 'created',
                direction: 'desc'
            });
            
            // Filter out issues that have exclusion labels
            const filteredIssues = issues.filter(issue => {
                const labelNames = issue.labels.map(label => 
                    typeof label === 'string' ? label : label.name
                );
                // Exclude if it has any of the exclusion tags
                return !labelNames.includes(AI_EXCLUDE_TAGS_PROCESSING) && 
                       !labelNames.includes(AI_DONE_TAG);
            });
            
            correlatedLogger.debug({ 
                repo: repoFullName, 
                totalIssues: issues.length,
                filteredIssues: filteredIssues.length,
                excludedLabels: [AI_EXCLUDE_TAGS_PROCESSING, AI_DONE_TAG]
            }, 'Filtered issues by labels');
            
            // Return in the same format as search API for compatibility
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
 * @param {Array<string>} githubUserWhitelist - List of allowed GitHub users
 * @param {string} prLabel - Label to filter PRs by (default: 'gitfix')
 */
export async function pollForPullRequestComments(octokit, repoFullName, correlationId, githubUserWhitelist = [], prLabel = null) {
    // If no trigger keywords are configured, skip PR comment polling entirely
    if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length === 0) {
        logger.debug({ repoFullName }, 'PR comment polling is disabled (no trigger keywords configured)');
        return;
    }

    const effectivePrLabel = prLabel || PR_LABEL;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');
    
    if (!owner || !repo) {
        correlatedLogger.warn({ repo: repoFullName }, 'Invalid repository format for PR comment polling. Skipping.');
        return;
    }

    correlatedLogger.debug({ 
        repository: repoFullName,
        triggerKeywords: PR_FOLLOWUP_TRIGGER_KEYWORDS,
        userBlacklist: GITHUB_USER_BLACKLIST,
        userWhitelist: githubUserWhitelist || [],
        botUsername: GITHUB_BOT_USERNAME,
        prLabel: effectivePrLabel
    }, 'Polling for PR comments');

    try {
        // Get all open PRs created by our bot
        const prs = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            state: 'open',
            per_page: 100
        });

        // Filter PRs to only those created by the bot
        const botPRs = prs.filter(pr => pr.user.login === GITHUB_BOT_USERNAME);
        
        correlatedLogger.info({ 
            repository: repoFullName, 
            totalPRs: prs.length,
            botPRs: botPRs.length 
        }, 'Found bot-created PRs');

        for (const pr of botPRs) {
            try {
                const prLabels = pr.labels.map(label => typeof label === 'string' ? label : label.name);
                if (!prLabels.includes(effectivePrLabel)) {
                    correlatedLogger.debug({
                        pullRequestNumber: pr.number,
                        prLabels,
                        requiredLabel: effectivePrLabel
                    }, 'Skipping PR without required label');
                    continue;
                }

                // Fetch all issue comments (general comments on the PR)
                const comments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: pr.number,
                    per_page: 100,
                    sort: 'created',
                    direction: 'desc'
                });

                // Process comments to find those that need follow-up work
                const eligibleComments = [];
                
                for (const comment of comments) {
                    // Skip comments from the bot itself
                    if (comment.user.login === GITHUB_BOT_USERNAME || comment.user.type === 'Bot') {
                        continue;
                    }

                    // Skip blacklisted users
                    if (GITHUB_USER_BLACKLIST.includes(comment.user.login)) {
                        correlatedLogger.debug({ 
                            user: comment.user.login, 
                            commentId: comment.id 
                        }, 'Skipping comment from blacklisted user');
                        continue;
                    }

                    // Apply whitelist if configured
                    if (githubUserWhitelist.length > 0 && !githubUserWhitelist.includes(comment.user.login)) {
                        correlatedLogger.debug({ 
                            user: comment.user.login, 
                            commentId: comment.id,
                            whitelist: githubUserWhitelist
                        }, 'Skipping comment from non-whitelisted user');
                        continue;
                    }

                    // Check if comment contains any trigger keyword (case-insensitive)
                    const commentLower = comment.body.toLowerCase();
                    const containsTrigger = PR_FOLLOWUP_TRIGGER_KEYWORDS.some(keyword => 
                        commentLower.includes(keyword.toLowerCase())
                    );

                    if (containsTrigger) {
                        correlatedLogger.info({
                            pullRequestNumber: pr.number,
                            commentId: comment.id,
                            commentAuthor: comment.user.login,
                            commentUrl: comment.html_url
                        }, 'Found eligible follow-up comment');

                        eligibleComments.push({
                            id: comment.id,
                            body: comment.body,
                            author: comment.user.login,
                            created_at: comment.created_at,
                            html_url: comment.html_url
                        });
                    }
                }

                // If there are eligible comments, create a job to process them
                if (eligibleComments.length > 0) {
                    const timestamp = Date.now();
                    const jobId = `pr-comment-${owner}-${repo}-${pr.number}-batch-${timestamp}`;
                    const jobData = {
                        pullRequestNumber: pr.number,
                        comments: eligibleComments, // Send all comments in batch
                        branchName: pr.head.ref,
                        repoOwner: owner,
                        repoName: repo,
                        llm: DEFAULT_MODEL_NAME,
                        correlationId: generateCorrelationId()
                    };

                    correlatedLogger.info({ 
                        jobId,
                        pullRequestNumber: pr.number,
                        commentCount: eligibleComments.length,
                        repository: repoFullName
                    }, 'Creating batch job for PR follow-up comments');

                    await issueQueue.add('processPullRequestComment', jobData, {
                        jobId,
                        attempts: 3,
                        backoff: {
                            type: 'exponential',
                            delay: 2000,
                        },
                    });
                }

            } catch (prError) {
                handleError(prError, `Error processing PR ${pr.number}`, { 
                    correlationId,
                    pullRequestNumber: pr.number,
                    repository: repoFullName 
                });
            }
        }

    } catch (error) {
        handleError(error, `Error polling PR comments for ${repoFullName}`, { correlationId });
    }
}