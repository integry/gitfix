import 'dotenv/config';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import logger from './utils/logger.js';
import { withErrorHandling, handleError } from './utils/errorHandler.js';
import { withRetry, retryConfigs } from './utils/retryHandler.js';
import { issueQueue, shutdownQueue } from './queue/taskQueue.js';
import Redis from 'ioredis';
import { ensureConfigRepoExists } from './config/configRepoManager.js';
import { loadReposFromConfig, loadSettingsFromConfig, detectBotUsername } from './polling/configLoader.js';
import { pollForIssues, closePollingConnections } from './polling/issuePolling.js';

// Configuration from environment variables
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10);
const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';
const AI_EXCLUDE_TAGS_PROCESSING = process.env.AI_EXCLUDE_TAGS_PROCESSING || 'AI-processing';

let monitoredRepos = [];
let GITHUB_USER_WHITELIST = [];
let GITHUB_BOT_USERNAME = null;
let PR_LABEL = null;

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

        // Clear the queue itself
        await issueQueue.drain();
        await issueQueue.obliterate({ force: true });
        logger.info('BullMQ queue cleared');

        // Clear any daemon-specific keys
        const keys = await redis.keys('daemon:*');
        if (keys.length > 0) {
            await redis.del(...keys);
            logger.info(`Deleted ${keys.length} daemon-specific keys`);
        }

        await redis.quit();
        logger.info('Queue reset completed successfully');
    } catch (error) {
        logger.error({ error: error.message }, 'Error resetting queues');
        throw error;
    }
}

/**
 * Resets labels on existing issues (removes AI-processing tag)
 */
async function resetIssueLabels() {
    logger.info('Resetting issue labels...');
    
    try {
        const octokit = await getAuthenticatedOctokit();
        const repos = monitoredRepos.length > 0 ? monitoredRepos : (process.env.GITHUB_REPOS_TO_MONITOR || '').split(',').map(r => r.trim()).filter(r => r);
        
        for (const repoFullName of repos) {
            const [owner, repo] = repoFullName.split('/');
            
            if (!owner || !repo) {
                logger.warn({ repo: repoFullName }, 'Invalid repository format. Skipping.');
                continue;
            }

            logger.info({ repository: repoFullName }, 'Checking issues for label reset');

            try {
                // Get all issues with AI-processing tag
                const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
                    owner,
                    repo,
                    state: 'open',
                    labels: AI_EXCLUDE_TAGS_PROCESSING,
                    per_page: 100
                });

                logger.info({ 
                    repository: repoFullName, 
                    count: issues.length 
                }, `Found ${issues.length} issues with ${AI_EXCLUDE_TAGS_PROCESSING} tag`);

                for (const issue of issues) {
                    try {
                        // Remove the AI-processing tag
                        await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                            owner,
                            repo,
                            issue_number: issue.number,
                            name: AI_EXCLUDE_TAGS_PROCESSING
                        });

                        logger.info({ 
                            repository: repoFullName,
                            issueNumber: issue.number 
                        }, `Removed ${AI_EXCLUDE_TAGS_PROCESSING} tag from issue`);

                    } catch (labelError) {
                        if (labelError.status === 404) {
                            logger.warn({ 
                                repository: repoFullName,
                                issueNumber: issue.number 
                            }, 'Label already removed');
                        } else {
                            logger.error({ 
                                repository: repoFullName,
                                issueNumber: issue.number,
                                error: labelError.message 
                            }, 'Failed to remove label');
                        }
                    }
                }
            } catch (repoError) {
                logger.error({ 
                    repository: repoFullName,
                    error: repoError.message 
                }, 'Failed to process repository');
            }
        }
        
        logger.info('Issue label reset completed');
    } catch (error) {
        logger.error({ error: error.message }, 'Error resetting issue labels');
        throw error;
    }
}

/**
 * Main daemon function that runs the polling loop
 * @param {Object} options - Daemon options
 */
async function startDaemon(options = {}) {
    logger.info('GitHub issue monitoring daemon starting...');
    
    // Initialize configuration
    if (process.env.CONFIG_REPO) {
        logger.info({ configRepo: process.env.CONFIG_REPO }, 'Ensuring config repository exists');
        await ensureConfigRepoExists();
    }
    
    // Load repositories and settings
    monitoredRepos = await loadReposFromConfig();
    const settings = await loadSettingsFromConfig();
    GITHUB_USER_WHITELIST = settings.github_user_whitelist || [];
    PR_LABEL = settings.pr_label || process.env.PR_LABEL || 'gitfix';
    
    // Auto-detect bot username
    const octokit = await getAuthenticatedOctokit();
    GITHUB_BOT_USERNAME = await detectBotUsername(octokit);
    
    const repos = monitoredRepos.length > 0 ? monitoredRepos : [];
    
    if (repos.length === 0) {
        logger.error('No repositories configured for monitoring. Set GITHUB_REPOS_TO_MONITOR or use CONFIG_REPO');
        throw new Error('No repositories to monitor');
    }

    logger.info({ 
        repositories: repos, 
        pollingInterval: POLLING_INTERVAL_MS,
        primaryTag: AI_PRIMARY_TAG,
        excludeTags: [AI_EXCLUDE_TAGS_PROCESSING, AI_DONE_TAG],
        botUsername: GITHUB_BOT_USERNAME,
        userWhitelist: GITHUB_USER_WHITELIST,
        prLabel: PR_LABEL
    }, 'Daemon configuration');

    // Reset queues if requested
    if (options.reset) {
        await resetQueues();
    }

    // Reset issue labels if requested
    if (options.resetLabels) {
        await resetIssueLabels();
    }

    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    });

    // Heartbeat function
    const daemonId = process.env.DAEMON_ID || `daemon-${process.pid}`;
    const sendHeartbeat = async () => {
        try {
            const heartbeat = {
                daemonId,
                timestamp: Date.now(),
                status: 'active',
                pid: process.pid,
                uptime: process.uptime(),
                repositories: repos,
                pollingInterval: POLLING_INTERVAL_MS
            };
            
            await heartbeatRedis.hset(
                'system:status:daemons',
                daemonId,
                JSON.stringify(heartbeat)
            );

            // Note: We only use hset for the hash, no need for sadd

            logger.debug({ daemonId }, 'Heartbeat sent');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send heartbeat');
        }
    };

    // Send initial heartbeat
    await sendHeartbeat();
    
    // Set up heartbeat interval (every 30 seconds)
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);

    // Polling function wrapper
    const runPollingCycle = async () => {
        try {
            await sendHeartbeat(); // Send heartbeat before each polling cycle
            await pollForIssues(repos, GITHUB_USER_WHITELIST, PR_LABEL);
            
            // Reload configuration periodically
            monitoredRepos = await loadReposFromConfig();
            const settings = await loadSettingsFromConfig();
            GITHUB_USER_WHITELIST = settings.github_user_whitelist || [];
            PR_LABEL = settings.pr_label || process.env.PR_LABEL || 'gitfix';
            
        } catch (error) {
            handleError(error, 'Error in polling cycle');
        }
    };

    // Initial polling
    await runPollingCycle();

    // Set up polling interval
    const pollingIntervalId = setInterval(runPollingCycle, POLLING_INTERVAL_MS);

    // Graceful shutdown
    const shutdown = async (signal) => {
        logger.info({ signal }, 'Shutdown signal received, cleaning up...');
        
        // Clear intervals
        clearInterval(pollingIntervalId);
        clearInterval(heartbeatInterval);
        
        // Remove daemon from status tracking
        await heartbeatRedis.hdel('system:status:daemons', daemonId);
        
        // Close Redis connections
        await heartbeatRedis.quit();
        await closePollingConnections();
        
        // Shutdown queue
        await shutdownQueue();
        
        logger.info('Daemon shutdown complete');
        process.exit(0);
    };

    // Handle shutdown signals
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    logger.info('Daemon started successfully');
}

/**
 * Parse command-line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        reset: false,
        resetLabels: false,
        help: false
    };

    for (const arg of args) {
        if (arg === '--reset' || arg === '-r') {
            options.reset = true;
        } else if (arg === '--reset-labels' || arg === '-l') {
            options.resetLabels = true;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        }
    }

    return options;
}

/**
 * Show help message
 */
function showHelp() {
    console.log(`
GitHub Issue Monitoring Daemon

Usage: node daemon.js [options]

Options:
  -h, --help          Show this help message
  -r, --reset         Reset all queue data before starting
  -l, --reset-labels  Remove AI-processing tags from all issues

Environment Variables:
  GITHUB_REPOS_TO_MONITOR    Comma-separated list of repos (owner/repo)
  CONFIG_REPO               Config repository URL for dynamic configuration
  POLLING_INTERVAL_MS       Polling interval in milliseconds (default: 60000)
  AI_PRIMARY_TAG            Primary tag to identify AI issues (default: AI)
  AI_EXCLUDE_TAGS_PROCESSING Tag that excludes issues from processing (default: AI-processing)
  AI_DONE_TAG               Tag that marks completed issues (default: AI-done)
  MODEL_LABEL_PATTERN       Regex pattern for model labels (default: ^llm-claude-(.+)$)
  DEFAULT_CLAUDE_MODEL      Default Claude model to use
  GITHUB_BOT_USERNAME       Bot username (auto-detected if not set)
  GITHUB_USER_WHITELIST     Comma-separated list of allowed users for PR comments
  GITHUB_USER_BLACKLIST     Comma-separated list of blocked users
  PR_FOLLOWUP_TRIGGER_KEYWORDS Comma-separated keywords that trigger PR follow-ups
  REDIS_HOST                Redis host (default: 127.0.0.1)
  REDIS_PORT                Redis port (default: 6379)

Examples:
  node daemon.js                    Start daemon with default settings
  node daemon.js --reset            Reset queues and start daemon
  node daemon.js --reset-labels     Remove processing tags and start
`);
}

// Main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArgs();
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }

    startDaemon(options).catch(error => {
        logger.error({ error: error.message, stack: error.stack }, 'Daemon startup failed');
        process.exit(1);
    });
}

export { startDaemon };