import simpleGit from 'simple-git';
import logger from '../../utils/logger.js';
import { handleError } from '../../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../../utils/retryHandler.js';

// Configuration from environment variables
const GIT_DEFAULT_BRANCH = process.env.GIT_DEFAULT_BRANCH || 'main';

// In-memory cache for repository configurations (branch names, etc)
const repositoryConfigCache = new Map();

/**
 * Generates a cache key for repository configuration
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {string} Cache key
 */
function getRepoConfigKey(owner, repoName) {
    return `${owner}/${repoName}`;
}

/**
 * Detects the default branch of a repository
 * @param {Object} git - SimpleGit instance
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @param {Object|null} octokit - Optional authenticated Octokit instance for API calls
 * @returns {Promise<string>} Default branch name
 */
export async function detectDefaultBranch(git, owner, repoName, octokit = null) {
    const cacheKey = getRepoConfigKey(owner, repoName);
    
    // Check cache first
    const cachedConfig = repositoryConfigCache.get(cacheKey);
    if (cachedConfig && cachedConfig.defaultBranch) {
        logger.debug({
            repo: `${owner}/${repoName}`,
            defaultBranch: cachedConfig.defaultBranch,
            source: 'cache'
        }, 'Using cached default branch');
        return cachedConfig.defaultBranch;
    }
    
    try {
        // Method 1: Use GitHub API if octokit is available (most reliable)
        if (octokit) {
            try {
                const { data: repoData } = await octokit.repos.get({ owner, repo: repoName });
                const defaultBranch = repoData.default_branch;
                
                // Cache the result
                repositoryConfigCache.set(cacheKey, {
                    ...cachedConfig,
                    defaultBranch,
                    lastUpdated: Date.now()
                });
                
                logger.info({
                    repo: `${owner}/${repoName}`,
                    defaultBranch,
                    source: 'github_api'
                }, 'Detected default branch via GitHub API');
                
                return defaultBranch;
            } catch (apiError) {
                logger.warn({
                    repo: `${owner}/${repoName}`,
                    error: apiError.message
                }, 'Failed to get default branch via GitHub API, falling back to git methods');
            }
        }
        
        // Method 2: Check the remote HEAD
        const remoteInfo = await git.remote(['show', 'origin']);
        const match = remoteInfo.match(/HEAD branch: (.+)/);
        
        if (match && match[1]) {
            const defaultBranch = match[1].trim();
            
            // Cache the result
            repositoryConfigCache.set(cacheKey, {
                ...cachedConfig,
                defaultBranch,
                lastUpdated: Date.now()
            });
            
            logger.info({
                repo: `${owner}/${repoName}`,
                defaultBranch,
                source: 'remote_head'
            }, 'Detected default branch from remote HEAD');
            
            return defaultBranch;
        }
        
        // Method 3: Check common branch names
        const branches = await git.branch(['-r']);
        const remoteBranches = branches.all.filter(b => b.startsWith('origin/'));
        
        const commonDefaults = ['origin/main', 'origin/master', 'origin/develop'];
        for (const branch of commonDefaults) {
            if (remoteBranches.includes(branch)) {
                const defaultBranch = branch.replace('origin/', '');
                
                // Cache the result
                repositoryConfigCache.set(cacheKey, {
                    ...cachedConfig,
                    defaultBranch,
                    lastUpdated: Date.now()
                });
                
                logger.info({
                    repo: `${owner}/${repoName}`,
                    defaultBranch,
                    source: 'common_names'
                }, 'Detected default branch from common names');
                
                return defaultBranch;
            }
        }
        
        // Method 4: Use environment variable default
        logger.warn({
            repo: `${owner}/${repoName}`,
            fallback: GIT_DEFAULT_BRANCH
        }, 'Could not detect default branch, using environment default');
        
        // Cache even the fallback
        repositoryConfigCache.set(cacheKey, {
            ...cachedConfig,
            defaultBranch: GIT_DEFAULT_BRANCH,
            lastUpdated: Date.now()
        });
        
        return GIT_DEFAULT_BRANCH;
        
    } catch (error) {
        logger.error({
            repo: `${owner}/${repoName}`,
            error: error.message
        }, 'Error detecting default branch');
        
        // Return environment default as last resort
        return GIT_DEFAULT_BRANCH;
    }
}

/**
 * Lists all cached repository branch configurations
 * @returns {Object} Map of repository configurations
 */
export function listRepositoryBranchConfigurations() {
    const configs = {};
    
    for (const [key, value] of repositoryConfigCache.entries()) {
        configs[key] = {
            ...value,
            age: value.lastUpdated ? Date.now() - value.lastUpdated : null
        };
    }
    
    return configs;
}

/**
 * Ensures a branch exists and pushes it to remote
 * @param {string} worktreePath - Path to the worktree
 * @param {string} branchName - Branch name
 * @param {string} baseBranch - Base branch to create from
 * @param {Object} options - Additional options
 * @returns {Promise<boolean>} Whether the branch was created
 */
export async function ensureBranchAndPush(worktreePath, branchName, baseBranch, options = {}) {
    const {
        repoUrl,
        authToken,
        tokenRefreshFn,
        correlationId
    } = options;
    
    const git = simpleGit(worktreePath);
    
    try {
        // First check if the branch already exists locally
        const localBranches = await git.branchLocal();
        const branchExists = localBranches.all.includes(branchName);
        
        if (branchExists) {
            logger.info({ branchName, worktreePath }, 'Branch already exists locally');
            
            // Make sure we're on the right branch
            await git.checkout(branchName);
            
            // Check if it exists on remote
            try {
                await git.fetch(['origin', branchName]);
                logger.info({ branchName }, 'Branch exists on remote');
                return false; // Branch already existed
            } catch (fetchError) {
                // Branch doesn't exist on remote, we'll push it
                logger.info({ branchName }, 'Branch does not exist on remote, will push');
            }
        } else {
            // Create the branch from the base branch
            logger.info({ 
                branchName, 
                baseBranch, 
                worktreePath 
            }, 'Creating new branch');
            
            // Ensure we have the latest base branch
            try {
                await git.fetch(['origin', baseBranch]);
                await git.checkout(['-b', branchName, `origin/${baseBranch}`]);
            } catch (checkoutError) {
                // If remote base branch doesn't exist, try local
                logger.warn({ 
                    baseBranch,
                    error: checkoutError.message 
                }, 'Could not create branch from remote base, trying local');
                await git.checkout(['-b', branchName, baseBranch]);
            }
        }
        
        // Push the branch to remote
        if (repoUrl && authToken) {
            await pushBranch(worktreePath, branchName, options);
        }
        
        return !branchExists; // Return true if we created a new branch
        
    } catch (error) {
        handleError(error, 'Failed to ensure branch exists', { 
            branchName, 
            baseBranch, 
            worktreePath,
            correlationId
        });
        throw error;
    }
}

/**
 * Pushes a branch to remote repository
 * @param {string} worktreePath - Path to the worktree
 * @param {string} branchName - Branch name to push
 * @param {Object} options - Push options
 */
export async function pushBranch(worktreePath, branchName, options = {}) {
    const {
        repoUrl,
        authToken,
        tokenRefreshFn,
        correlationId
    } = options;
    
    const git = simpleGit(worktreePath);
    
    try {
        // Set up authenticated remote if credentials provided
        if (repoUrl && authToken) {
            const { setupAuthenticatedRemote } = await import('./repoCloning.js');
            await setupAuthenticatedRemote(git, repoUrl, authToken);
        }
        
        // Push with retry logic
        const pushWithRetry = async (token) => {
            if (repoUrl && token) {
                const { setupAuthenticatedRemote } = await import('./repoCloning.js');
                await setupAuthenticatedRemote(git, repoUrl, token);
            }
            
            await git.push(['origin', branchName, '--set-upstream']);
        };
        
        await withRetry(
            async () => {
                try {
                    await pushWithRetry(authToken);
                } catch (error) {
                    // If we get an auth error and have a token refresh function, try refreshing
                    if (error.message && error.message.includes('Authentication failed') && tokenRefreshFn) {
                        logger.info({ branchName }, 'Authentication failed, attempting token refresh');
                        const newToken = await tokenRefreshFn();
                        await pushWithRetry(newToken);
                    } else {
                        throw error;
                    }
                }
            },
            { ...retryConfigs.gitOperations, correlationId },
            `push_branch_${branchName}`
        );
        
        logger.info({ 
            branchName, 
            worktreePath 
        }, 'Successfully pushed branch to remote');
        
    } catch (error) {
        handleError(error, 'Failed to push branch', { 
            branchName, 
            worktreePath,
            correlationId
        });
        throw error;
    }
}