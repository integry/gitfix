import logger from './logger.js';

/**
 * Standard error handler for async operations
 * @param {Error} error - The error object
 * @param {string} context - Context where the error occurred
 * @param {boolean} exit - Whether to exit the process
 */
export function handleError(error, context, exit = false) {
    logger.error({
        msg: `Error in ${context}`,
        error: {
            message: error.message,
            stack: error.stack,
            code: error.code,
        },
        context,
    });

    if (exit) {
        process.exit(1);
    }
}

/**
 * Wraps an async function with error handling
 * @param {Function} fn - The async function to wrap
 * @param {string} context - Context for error logging
 * @returns {Function} Wrapped function
 */
export function withErrorHandling(fn, context) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            handleError(error, context);
            throw error;
        }
    };
}

/**
 * Creates a safe async function that doesn't throw
 * @param {Function} fn - The async function to wrap
 * @param {*} defaultValue - Default value to return on error
 * @returns {Function} Wrapped function
 */
export function safeAsync(fn, defaultValue = null) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            logger.error('Safe async operation failed', { error: error.message });
            return defaultValue;
        }
    };
}