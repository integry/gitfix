import logger from './logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';

/**
 * Error categories for classification
 */
export const ErrorCategories = {
    GITHUB_API: 'github_api',
    CLAUDE_EXECUTION: 'claude_execution',
    GIT_OPERATION: 'git_operation',
    DOCKER_OPERATION: 'docker_operation',
    REDIS_OPERATION: 'redis_operation',
    POST_PROCESSING: 'post_processing',
    AUTHENTICATION: 'authentication',
    NETWORK: 'network',
    VALIDATION: 'validation',
    UNKNOWN: 'unknown'
};

/**
 * Failure labels for GitHub issues
 */
const FailureLabels = {
    [ErrorCategories.GITHUB_API]: 'AI-failed-github-api',
    [ErrorCategories.CLAUDE_EXECUTION]: 'AI-failed-claude',
    [ErrorCategories.GIT_OPERATION]: 'AI-failed-git',
    [ErrorCategories.DOCKER_OPERATION]: 'AI-failed-docker',
    [ErrorCategories.REDIS_OPERATION]: 'AI-failed-redis',
    [ErrorCategories.POST_PROCESSING]: 'AI-failed-post-processing',
    [ErrorCategories.AUTHENTICATION]: 'AI-failed-auth',
    [ErrorCategories.NETWORK]: 'AI-failed-network',
    [ErrorCategories.VALIDATION]: 'AI-failed-validation',
    [ErrorCategories.UNKNOWN]: 'AI-failed'
};

/**
 * Categorizes an error based on its properties
 * @param {Error} error - The error to categorize
 * @param {string} context - Context where the error occurred
 * @returns {string} Error category
 */
export function categorizeError(error, context = '') {
    // Check error codes
    if (error.code) {
        if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) {
            return ErrorCategories.NETWORK;
        }
        if (error.code.includes('GIT')) {
            return ErrorCategories.GIT_OPERATION;
        }
    }
    
    // Check HTTP status codes for GitHub API errors
    if (error.status) {
        if (error.status === 401 || error.status === 403) {
            return ErrorCategories.AUTHENTICATION;
        }
        if (error.status >= 400 && error.status < 500) {
            return ErrorCategories.GITHUB_API;
        }
    }
    
    // Check error messages
    const message = error.message?.toLowerCase() || '';
    if (message.includes('docker')) {
        return ErrorCategories.DOCKER_OPERATION;
    }
    if (message.includes('claude')) {
        return ErrorCategories.CLAUDE_EXECUTION;
    }
    if (message.includes('git') || message.includes('repository')) {
        return ErrorCategories.GIT_OPERATION;
    }
    if (message.includes('redis')) {
        return ErrorCategories.REDIS_OPERATION;
    }
    if (message.includes('github') || message.includes('api')) {
        return ErrorCategories.GITHUB_API;
    }
    if (message.includes('auth')) {
        return ErrorCategories.AUTHENTICATION;
    }
    
    // Check context
    const contextLower = context.toLowerCase();
    if (contextLower.includes('claude')) {
        return ErrorCategories.CLAUDE_EXECUTION;
    }
    if (contextLower.includes('git')) {
        return ErrorCategories.GIT_OPERATION;
    }
    if (contextLower.includes('github') || contextLower.includes('api')) {
        return ErrorCategories.GITHUB_API;
    }
    if (contextLower.includes('post')) {
        return ErrorCategories.POST_PROCESSING;
    }
    
    return ErrorCategories.UNKNOWN;
}

/**
 * Enhanced error handler for async operations with correlation ID support
 * @param {Error} error - The error object
 * @param {string} context - Context where the error occurred
 * @param {object} options - Additional options
 * @param {string} options.correlationId - Correlation ID for tracking
 * @param {boolean} options.exit - Whether to exit the process
 * @param {object} options.issueRef - GitHub issue reference for failure tagging
 * @returns {object} Error details including category
 */
export function handleError(error, context, options = {}) {
    const {
        correlationId,
        exit = false,
        issueRef = null
    } = options;
    
    const category = categorizeError(error, context);
    const correlatedLogger = correlationId ? 
        logger.withCorrelation(correlationId) : logger;
    
    const errorDetails = {
        category,
        message: error.message,
        stack: error.stack,
        code: error.code,
        status: error.status,
        context,
        timestamp: new Date().toISOString()
    };
    
    correlatedLogger.error({
        msg: `Error in ${context}`,
        error: errorDetails,
        context,
        category
    });
    
    // Handle issue failure tagging if issue reference is provided
    if (issueRef) {
        handleIssueFailure(issueRef, category, error, correlationId).catch(tagError => {
            logger.warn({
                correlationId,
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                error: tagError.message
            }, 'Failed to update issue failure tags');
        });
    }

    if (exit) {
        process.exit(1);
    }
    
    return errorDetails;
}

/**
 * Handles issue failure by updating GitHub labels
 * @param {object} issueRef - GitHub issue reference
 * @param {string} errorCategory - Categorized error type
 * @param {Error} originalError - The original error
 * @param {string} correlationId - Correlation ID
 */
async function handleIssueFailure(issueRef, errorCategory, originalError, correlationId) {
    const correlatedLogger = correlationId ? 
        logger.withCorrelation(correlationId) : logger;
    
    try {
        const octokit = await getAuthenticatedOctokit();
        const failureLabel = FailureLabels[errorCategory] || FailureLabels[ErrorCategories.UNKNOWN];
        
        // Remove processing tag and add failure tag
        const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
        
        try {
            await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                name: AI_PROCESSING_TAG,
            });
        } catch (removeError) {
            // Ignore errors when removing labels that don't exist
            correlatedLogger.debug({
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                error: removeError.message
            }, 'Could not remove processing tag (may not exist)');
        }
        
        // Add failure tag
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: issueRef.number,
            labels: [failureLabel],
        });
        
        // Add failure comment
        const failureComment = `🚨 **AI Processing Failed**

**Error Category:** ${errorCategory}
**Error Message:** ${originalError.message}
**Correlation ID:** ${correlationId || 'unknown'}
**Timestamp:** ${new Date().toISOString()}

This issue has been marked as failed and moved to the Dead Letter Queue for manual investigation.

---
*This is an automated message from the Claude-powered GitHub Issue Processor*`;
        
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: issueRef.number,
            body: failureComment,
        });
        
        correlatedLogger.info({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            failureLabel,
            errorCategory
        }, 'Updated issue with failure tags and comment');
        
    } catch (tagError) {
        correlatedLogger.error({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            error: tagError.message,
            originalError: originalError.message
        }, 'Failed to update issue failure tags');
        throw tagError;
    }
}

/**
 * Wraps an async function with enhanced error handling
 * @param {Function} fn - The async function to wrap
 * @param {string} context - Context for error logging
 * @param {object} options - Additional options
 * @returns {Function} Wrapped function
 */
export function withErrorHandling(fn, context, options = {}) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            handleError(error, context, options);
            throw error;
        }
    };
}

/**
 * Creates a safe async function that doesn't throw
 * @param {Function} fn - The async function to wrap
 * @param {*} defaultValue - Default value to return on error
 * @param {object} options - Additional options
 * @returns {Function} Wrapped function
 */
export function safeAsync(fn, defaultValue = null, options = {}) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            const correlatedLogger = options.correlationId ? 
                logger.withCorrelation(options.correlationId) : logger;
            
            correlatedLogger.error('Safe async operation failed', { 
                error: error.message,
                context: options.context || 'safe_async'
            });
            return defaultValue;
        }
    };
}

/**
 * Creates an idempotent operation wrapper
 * @param {Function} fn - The async function to make idempotent
 * @param {Function} checkFn - Function to check if operation already completed
 * @param {string} context - Context for logging
 * @returns {Function} Idempotent wrapped function
 */
export function makeIdempotent(fn, checkFn, context = 'operation') {
    return async (...args) => {
        const correlationId = args.find(arg => arg?.correlationId)?.correlationId;
        const correlatedLogger = correlationId ? 
            logger.withCorrelation(correlationId) : logger;
        
        try {
            // Check if operation was already completed
            const alreadyCompleted = await checkFn(...args);
            if (alreadyCompleted) {
                correlatedLogger.info({
                    context,
                    status: 'already_completed'
                }, `${context} already completed, skipping`);
                return alreadyCompleted;
            }
            
            // Perform the operation
            return await fn(...args);
            
        } catch (error) {
            handleError(error, `idempotent_${context}`, { correlationId });
            throw error;
        }
    };
}