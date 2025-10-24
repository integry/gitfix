/**
 * Claude Service
 * 
 * This module provides a unified interface for Claude-related operations by re-exporting
 * functionality from specialized submodules.
 */

// Re-export prompt generation functions
export { 
    generateClaudePrompt,
    generateTaskImportPrompt,
    generateRetryPrompt
} from './modules/promptGeneration.js';

// Re-export Docker operations
export { 
    buildClaudeDockerImage,
    isDockerAvailable,
    getContainerLogs,
    removeContainer
} from './modules/dockerOperations.js';

// Re-export Claude execution
export { 
    executeClaudeCode,
    UsageLimitError
} from './modules/claudeExecution.js';

// Keep backward compatibility by exporting a default object with all functions
import * as promptGen from './modules/promptGeneration.js';
import * as dockerOps from './modules/dockerOperations.js';
import * as claudeExec from './modules/claudeExecution.js';

export default {
    ...promptGen,
    ...dockerOps,
    ...claudeExec
};