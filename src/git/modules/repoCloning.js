import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../../utils/logger.js';
import { withRetry, retryConfigs } from '../../utils/retryHandler.js';

// Configuration from environment variables
const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || "/tmp/git-processor/clones";
const GIT_SHALLOW_CLONE_DEPTH = process.env.GIT_SHALLOW_CLONE_DEPTH ? parseInt(process.env.GIT_SHALLOW_CLONE_DEPTH) : undefined;

/**
 * Sets up authenticated remote URL for a Git repository
 * @param {Object} git - SimpleGit instance
 * @param {string} repoUrl - Base repository URL
 * @param {string} authToken - GitHub authentication token
 * @returns {Promise<void>}
 */
export async function setupAuthenticatedRemote(git, repoUrl, authToken) {
    const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
    await git.remote(['set-url', 'origin', authenticatedUrl]);
}

/**
 * Gets the local path for a repository clone
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {Promise<string>} Local repository path
 */
export async function getRepoPath(owner, repoName) {
    return path.join(CLONES_BASE_PATH, owner, repoName);
}

/**
 * Ensures a repository is cloned locally and up to date
 * @param {string} repoUrl - Repository URL (e.g., https://github.com/owner/repo.git)
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} authToken - GitHub authentication token
 * @returns {Promise<string>} Local repository path
 */
export async function ensureRepoCloned(repoUrl, owner, repoName, authToken) {
    const localRepoPath = await getRepoPath(owner, repoName);
    
    try {
        // Check if repository already exists
        if (await fs.pathExists(path.join(localRepoPath, ".git"))) {
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath 
            }, 'Repository exists locally. Validating and fetching updates...');
            
            // Validate that it's a proper git repository
            try {
                const git = simpleGit(localRepoPath);
                const isRepo = await git.checkIsRepo();
                
                if (!isRepo) {
                    throw new Error('Directory exists but is not a valid git repository');
                }
                
                // Set up authentication for fetch
                await setupAuthenticatedRemote(git, repoUrl, authToken);
                
                await git.fetch(['origin', '--prune']);
            } catch (gitError) {
                logger.warn({ 
                    repo: `${owner}/${repoName}`, 
                    path: localRepoPath,
                    error: gitError.message 
                }, 'Git repository is corrupted or invalid. Removing and re-cloning...');
                
                // Remove the corrupted repository
                await fs.remove(localRepoPath);
                
                // Fall through to clone logic
                return ensureRepoCloned(repoUrl, owner, repoName, authToken);
            }
            
            // Re-create git instance after validation
            const git = simpleGit(localRepoPath);
            
            // Ensure we're on the correct default branch in the main repository
            const { detectDefaultBranch } = await import('./branchOperations.js');
            const defaultBranch = await detectDefaultBranch(git, owner, repoName);
            
            try {
                // Check out the default branch to ensure worktrees are created from the correct base
                await git.checkout(defaultBranch);
                logger.info({ 
                    repo: `${owner}/${repoName}`, 
                    defaultBranch 
                }, 'Checked out default branch in main repository');
            } catch (checkoutError) {
                logger.warn({ 
                    repo: `${owner}/${repoName}`, 
                    defaultBranch,
                    error: checkoutError.message 
                }, 'Could not checkout default branch, it may not exist locally yet');
                
                // Try to create the branch from origin
                try {
                    await git.checkoutBranch(defaultBranch, `origin/${defaultBranch}`);
                    logger.info({ 
                        repo: `${owner}/${repoName}`, 
                        defaultBranch 
                    }, 'Created and checked out default branch from origin');
                } catch (createError) {
                    logger.warn({ 
                        repo: `${owner}/${repoName}`, 
                        defaultBranch,
                        error: createError.message 
                    }, 'Could not create default branch from origin, continuing with current branch');
                }
            }
            
        } else {
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath 
            }, 'Repository not found locally. Cloning...');
            
            // Ensure the parent directory exists
            await fs.ensureDir(path.dirname(localRepoPath));
            
            const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
            
            const cloneOptions = ['--recurse-submodules'];
            
            // Add shallow clone option if configured
            if (GIT_SHALLOW_CLONE_DEPTH) {
                logger.info({ 
                    repo: `${owner}/${repoName}`, 
                    depth: GIT_SHALLOW_CLONE_DEPTH 
                }, 'Using shallow clone with limited depth');
                cloneOptions.push('--depth', GIT_SHALLOW_CLONE_DEPTH.toString());
            }
            
            // Clone with retry logic
            await withRetry(
                async () => {
                    const git = simpleGit();
                    await git.clone(authenticatedUrl, localRepoPath, cloneOptions);
                },
                retryConfigs.gitOperations,
                'clone_repository'
            );
            
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath 
            }, 'Successfully cloned repository');
            
            // If shallow clone was used, we may need to fetch tags separately
            if (GIT_SHALLOW_CLONE_DEPTH) {
                try {
                    const git = simpleGit(localRepoPath);
                    await git.fetch(['--tags']);
                    logger.info({ 
                        repo: `${owner}/${repoName}` 
                    }, 'Fetched tags for shallow clone');
                } catch (tagError) {
                    logger.warn({ 
                        repo: `${owner}/${repoName}`,
                        error: tagError.message 
                    }, 'Failed to fetch tags for shallow clone');
                }
            }
        }
        
        return localRepoPath;
        
    } catch (error) {
        logger.error({ 
            repo: `${owner}/${repoName}`, 
            path: localRepoPath,
            error: error.message 
        }, 'Failed to ensure repository is cloned');
        throw error;
    }
}

/**
 * Gets the repository URL from issue reference
 * @param {Object} issue - Issue reference containing repoOwner and repoName
 * @returns {string} Repository URL
 */
export function getRepoUrl(issue) {
    // If issue contains a full repoUrl, use it directly
    if (issue.repoUrl) {
        return issue.repoUrl;
    }
    
    // Otherwise, construct from owner and repo name
    return `https://github.com/${issue.repoOwner}/${issue.repoName}.git`;
}