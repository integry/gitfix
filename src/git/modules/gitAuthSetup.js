import simpleGit from 'simple-git';
import logger from '../../utils/logger.js';
import { withRetry, retryConfigs } from '../../utils/retryHandler.js';

/**
 * Sets up an authenticated remote for a repository
 * @param {string} repoPath - Path to the repository
 * @param {string} repoUrl - Original repository URL
 * @param {string} token - GitHub token
 * @returns {Promise<void>}
 */
export async function setupAuthenticatedRemote(repoPath, repoUrl, token) {
    const git = simpleGit(repoPath);
    
    // Normalize URL with authentication
    let authenticatedUrl;
    if (repoUrl.startsWith('git@')) {
        // Convert SSH to HTTPS with token
        const match = repoUrl.match(/git@github\.com:(.+)\/(.+?)(\.git)?$/);
        if (match) {
            authenticatedUrl = `https://${token}@github.com/${match[1]}/${match[2]}.git`;
        }
    } else {
        // Add token to HTTPS URL
        authenticatedUrl = repoUrl.replace('https://github.com/', `https://${token}@github.com/`);
    }
    
    try {
        // Check if origin exists
        const remotes = await git.getRemotes(true);
        const originRemote = remotes.find(r => r.name === 'origin');
        
        if (originRemote) {
            // Update existing remote
            await git.remote(['set-url', 'origin', authenticatedUrl]);
            logger.debug({ repoPath }, 'Updated origin remote with authenticated URL');
        } else {
            // Add new remote
            await git.remote(['add', 'origin', authenticatedUrl]);
            logger.debug({ repoPath }, 'Added authenticated origin remote');
        }
    } catch (error) {
        logger.error({ 
            error: error.message, 
            repoPath 
        }, 'Failed to setup authenticated remote');
        throw error;
    }
}

/**
 * Gets the repository configuration key for tracking branch configurations
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {string} Configuration key
 */
export function getRepoConfigKey(repoOwner, repoName) {
    return `repo:${repoOwner}/${repoName}:branches`;
}