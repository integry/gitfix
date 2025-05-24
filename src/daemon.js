import 'dotenv/config';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import logger from './utils/logger.js';
import { withErrorHandling, handleError } from './utils/errorHandler.js';
import { issueQueue, shutdownQueue } from './queue/taskQueue.js';

// Configuration from environment variables
const GITHUB_REPOS_TO_MONITOR = process.env.GITHUB_REPOS_TO_MONITOR;
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10);
const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_EXCLUDE_TAGS_PROCESSING = process.env.AI_EXCLUDE_TAGS_PROCESSING || 'AI-processing';
const AI_EXCLUDE_TAGS_DONE = process.env.AI_EXCLUDE_TAGS_DONE || 'AI-done';

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
 * @returns {Promise<Array>} Array of filtered issues
 */
async function fetchIssuesForRepo(octokit, repoFullName) {
    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) {
        logger.warn({ repo: repoFullName }, 'Invalid repository format. Skipping.');
        return [];
    }

    // Build exclusion labels query
    const excludeLabelsQuery = [AI_EXCLUDE_TAGS_PROCESSING, AI_EXCLUDE_TAGS_DONE]
        .map(tag => `-label:"${tag}"`)
        .join(' ');

    // Construct GitHub search query
    const query = `repo:${owner}/${repo} is:issue is:open label:"${AI_PRIMARY_TAG}" ${excludeLabelsQuery}`;
    logger.debug({ repo: repoFullName, query }, 'Constructed search query');

    try {
        const response = await octokit.request('GET /search/issues', {
            q: query,
            per_page: 100, // Get up to 100 issues per request
            sort: 'created',
            order: 'desc'
        });

        logger.info({ 
            repo: repoFullName, 
            count: response.data.total_count 
        }, `Found ${response.data.total_count} matching issues.`);

        // Transform issues to a simplified format
        return response.data.items.map(issue => ({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            repoOwner: owner,
            repoName: repo,
            labels: issue.labels.map(l => l.name),
            createdAt: issue.created_at,
            updatedAt: issue.updated_at
        }));
    } catch (error) {
        logger.error({ 
            repo: repoFullName, 
            errMessage: error.message, 
            status: error.status 
        }, 'Error fetching issues');

        // Check for rate limit errors
        if (error.status === 403 && error.message && error.message.includes('rate limit')) {
            logger.warn('GitHub API rate limit likely exceeded. Consider increasing polling interval.');
        }
        
        return [];
    }
}

/**
 * Main polling function that checks all configured repositories for issues
 */
async function pollForIssues() {
    logger.info('Starting GitHub issue polling cycle...');
    
    let octokit;
    try {
        octokit = await getAuthenticatedOctokit();
    } catch (authError) {
        handleError(authError, 'Failed to get authenticated Octokit instance');
        return;
    }

    const allDetectedIssues = [];
    const repos = getRepos();
    
    // Poll each configured repository
    for (const repoFullName of repos) {
        logger.debug({ repository: repoFullName }, 'Polling repository');
        
        try {
            const issues = await fetchIssuesForRepo(octokit, repoFullName);
            
            if (issues.length > 0) {
                for (const issue of issues) {
                    logger.info({ 
                        issueId: issue.id, 
                        issueNumber: issue.number, 
                        issueTitle: issue.title, 
                        issueUrl: issue.url,
                        repository: repoFullName
                    }, 'Detected eligible issue');
                    
                    // Add issue to the queue
                    try {
                        const jobId = `issue-${issue.repoOwner}-${issue.repoName}-${issue.number}`;
                        await issueQueue.add('processGitHubIssue', issue, {
                            jobId,
                            // Prevent duplicate jobs for the same issue
                            attempts: 3,
                            backoff: {
                                type: 'exponential',
                                delay: 2000,
                            },
                        });
                        
                        logger.info({ 
                            jobId,
                            issueNumber: issue.number,
                            repository: repoFullName
                        }, 'Successfully added issue to processing queue');
                        
                        allDetectedIssues.push(issue);
                    } catch (error) {
                        if (error.message?.includes('Job already exists')) {
                            logger.debug({ 
                                issueNumber: issue.number,
                                repository: repoFullName 
                            }, 'Issue already in queue, skipping');
                        } else {
                            handleError(error, `Failed to add issue ${issue.number} to queue`);
                        }
                    }
                }
            }
        } catch (error) {
            handleError(error, `Error polling repository ${repoFullName}`);
        }
    }
    
    logger.info({ 
        totalIssues: allDetectedIssues.length,
        repositories: repos.length 
    }, 'Polling cycle completed');
    
    return allDetectedIssues;
}

/**
 * Starts the daemon with configured polling interval
 */
function startDaemon() {
    const repos = getRepos();
    
    // Validate required configuration
    if (repos.length === 0) {
        logger.error('GITHUB_REPOS_TO_MONITOR environment variable is not set or empty. Exiting.');
        process.exit(1);
    }
    
    logger.info({
        repositories: repos,
        pollingInterval: POLLING_INTERVAL_MS,
        primaryTag: AI_PRIMARY_TAG,
        excludeProcessingTag: AI_EXCLUDE_TAGS_PROCESSING,
        excludeDoneTag: AI_EXCLUDE_TAGS_DONE
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
export { fetchIssuesForRepo, pollForIssues, startDaemon };

// Start daemon if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    startDaemon();
}