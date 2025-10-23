import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs-extra';
import logger from '../../utils/logger.js';
import { withRetry, retryConfigs } from '../../utils/retryHandler.js';
import { setupAuthenticatedRemote } from './gitAuthSetup.js';

// Configuration
const GIT_CONFIG = {
    timeout: {
        block: 120000,  // 2 minutes
    }
};

/**
 * Normalizes a GitHub repository URL to include authentication token
 * @param {string} url - The repository URL
 * @param {string} token - GitHub token for authentication
 * @returns {string} The authenticated URL
 */
export function normalizeRepoUrl(url, token) {
    if (url.startsWith('git@')) {
        // Convert SSH URL to HTTPS with token
        const match = url.match(/git@github\.com:(.+)\/(.+?)(\.git)?$/);
        if (match) {
            return `https://${token}@github.com/${match[1]}/${match[2]}.git`;
        }
    }
    
    if (url.includes('github.com') && !url.includes('@')) {
        // Add token to HTTPS URL if not already present
        return url.replace('https://github.com/', `https://${token}@github.com/`);
    }
    
    return url;
}

/**
 * Gets the local path for a repository
 * @param {string} owner - Repository owner
 * @param {string} name - Repository name
 * @returns {string} Local path for the repository
 */
export function getRepoPath(owner, name) {
    return path.join(process.env.GIT_REPOS_DIR || '/tmp/repos', owner, name);
}

/**
 * Validates and cleans repository name
 * @param {string} name - Repository name
 * @returns {string} Cleaned repository name
 */
export function cleanRepoName(name) {
    // Remove .git extension if present
    return name.replace(/\.git$/, '');
}

/**
 * Clones a repository with retry logic
 * @param {string} repoUrl - Repository URL
 * @param {string} localPath - Local path to clone to
 * @param {string} token - GitHub token
 * @returns {Promise<void>}
 */
export async function cloneRepository(repoUrl, localPath, token) {
    const authenticatedUrl = normalizeRepoUrl(repoUrl, token);
    const git = simpleGit({ ...GIT_CONFIG });
    
    logger.info({ localPath, repoUrl }, 'Cloning repository');
    
    await withRetry(
        async () => {
            await git.clone(authenticatedUrl, localPath);
        },
        retryConfigs.gitOperations,
        'clone_repository'
    );
    
    logger.info({ localPath }, 'Repository cloned successfully');
}

/**
 * Updates an existing repository
 * @param {string} localPath - Local repository path
 * @param {string} token - GitHub token
 * @param {string} repoUrl - Repository URL
 * @returns {Promise<void>}
 */
export async function updateRepository(localPath, token, repoUrl) {
    const git = simpleGit(localPath, { ...GIT_CONFIG });
    
    // Ensure we're using authenticated remote
    await setupAuthenticatedRemote(localPath, repoUrl, token);
    
    logger.info({ localPath }, 'Updating repository');
    
    await withRetry(
        async () => {
            await git.fetch('--all');
        },
        retryConfigs.gitOperations,
        'fetch_repository'
    );
    
    logger.info({ localPath }, 'Repository updated successfully');
}

/**
 * Ensures a repository is cloned and up to date
 * @param {string} repoUrl - The repository URL
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} token - GitHub token for authentication
 * @returns {Promise<string>} The local path to the repository
 */
export async function ensureRepoCloned(repoUrl, repoOwner, repoName, token) {
    const cleanName = cleanRepoName(repoName);
    const localRepoPath = getRepoPath(repoOwner, cleanName);
    
    logger.debug({
        repoUrl,
        repoOwner,
        repoName: cleanName,
        localRepoPath
    }, 'Ensuring repository is cloned');
    
    const repoExists = await fs.pathExists(localRepoPath);
    
    if (!repoExists) {
        await fs.ensureDir(path.dirname(localRepoPath));
        await cloneRepository(repoUrl, localRepoPath, token);
    } else {
        await updateRepository(localRepoPath, token, repoUrl);
    }
    
    return localRepoPath;
}