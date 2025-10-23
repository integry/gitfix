import logger from '../utils/logger.js';
import { loadMonitoredRepos, loadSettings } from '../config/configRepoManager.js';

/**
 * Loads repository configuration from either config repo or environment variables
 * @returns {Promise<Array<string>>} Array of repository names to monitor
 */
export async function loadReposFromConfig() {
    let monitoredRepos = [];
    
    try {
        if (process.env.CONFIG_REPO) {
            monitoredRepos = await loadMonitoredRepos();
            logger.info({ repos: monitoredRepos }, 'Successfully loaded monitored repositories from config repo');
        } else {
            monitoredRepos = getReposFromEnv();
            logger.info({ repos: monitoredRepos }, 'Using repositories from environment variable');
        }
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to load repositories from config, falling back to environment variable');
        monitoredRepos = getReposFromEnv();
    }
    
    return monitoredRepos;
}

/**
 * Loads settings from config repository including user whitelist
 * @returns {Promise<Object>} Settings object with github_user_whitelist
 */
export async function loadSettingsFromConfig() {
    let githubUserWhitelist = [];
    
    try {
        if (process.env.CONFIG_REPO) {
            const settings = await loadSettings();
            
            if (settings.github_user_whitelist && Array.isArray(settings.github_user_whitelist)) {
                githubUserWhitelist = settings.github_user_whitelist;
                logger.info({ whitelist: githubUserWhitelist }, 'Successfully loaded github_user_whitelist from config repo');
            } else if (process.env.GITHUB_USER_WHITELIST) {
                githubUserWhitelist = (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u);
                logger.info({ whitelist: githubUserWhitelist }, 'Using github_user_whitelist from environment variable');
            }
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load settings from config, using environment variable');
        githubUserWhitelist = (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u);
    }
    
    return { github_user_whitelist: githubUserWhitelist };
}

/**
 * Gets repositories from environment variable
 * @returns {Array<string>} Array of repository names
 */
function getReposFromEnv() {
    const GITHUB_REPOS_TO_MONITOR = process.env.GITHUB_REPOS_TO_MONITOR;
    if (!GITHUB_REPOS_TO_MONITOR) {
        return [];
    }
    return GITHUB_REPOS_TO_MONITOR.split(',').map(r => r.trim()).filter(r => r);
}

/**
 * Auto-detect the bot username by querying the GitHub API
 * @param {import('@octokit/core').Octokit} octokit - Authenticated Octokit instance
 * @returns {Promise<string>} Bot username
 */
export async function detectBotUsername(octokit) {
    let GITHUB_BOT_USERNAME = process.env.GITHUB_BOT_USERNAME;
    
    if (GITHUB_BOT_USERNAME) {
        return GITHUB_BOT_USERNAME; // Already configured
    }

    try {
        // GitHub Apps can't access GET /user, so we get the app info instead
        const { data: installation } = await octokit.request('GET /installation');
        // The bot username is the app slug with [bot] suffix
        GITHUB_BOT_USERNAME = `${installation.app_slug}[bot]`;
        logger.info({ botUsername: GITHUB_BOT_USERNAME }, 'Auto-detected bot username');
        return GITHUB_BOT_USERNAME;
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to auto-detect bot username, will use default');
        GITHUB_BOT_USERNAME = 'github-actions[bot]';
        return GITHUB_BOT_USERNAME;
    }
}