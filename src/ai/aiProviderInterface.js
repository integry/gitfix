/**
 * Abstract base class for AI providers
 * All AI provider implementations must extend this class and implement the required methods
 */
export class AIProviderInterface {
    constructor(config = {}) {
        this.config = config;
        this.providerName = 'unknown';
        this.supportedModels = [];
    }

    /**
     * Executes AI code analysis and modification for a GitHub issue
     * @param {Object} options - Execution options
     * @param {string} options.worktreePath - Path to the Git worktree containing the repository
     * @param {Object} options.issueRef - GitHub issue reference
     * @param {string} options.githubToken - GitHub authentication token
     * @param {string} options.customPrompt - Custom prompt to use instead of default (optional)
     * @param {boolean} options.isRetry - Whether this is a retry attempt (optional)
     * @param {string} options.retryReason - Reason for retry (optional)
     * @param {string} options.branchName - The specific branch name to use (optional)
     * @param {string} options.modelName - The AI model being used (optional)
     * @returns {Promise<Object>} AI execution result
     */
    async executeCode(options) {
        throw new Error('executeCode method must be implemented by AI provider');
    }

    /**
     * Generates a context-aware prompt for the AI to analyze and fix GitHub issues
     * @param {Object} issueRef - GitHub issue reference
     * @param {string} issueRef.number - Issue number
     * @param {string} issueRef.repoOwner - Repository owner
     * @param {string} issueRef.repoName - Repository name
     * @param {string} branchName - The specific branch name to use (optional)
     * @param {string} modelName - The AI model being used (optional)
     * @returns {string} Formatted prompt for the AI
     */
    generatePrompt(issueRef, branchName = null, modelName = null) {
        const branchInfo = branchName ? `\n- **BRANCH**: You are working on branch \`${branchName}\`.` : '';
        const modelInfo = modelName ? `\n- **MODEL**: This task is being processed by the \`${modelName}\` model.` : '';
        
        return `Please analyze and implement a solution for GitHub issue #${issueRef.number}.

**REPOSITORY INFORMATION:**
- Repository Owner: ${issueRef.repoOwner}
- Repository Name: ${issueRef.repoName}
- Full Repository: ${issueRef.repoOwner}/${issueRef.repoName}${branchInfo}${modelInfo}

**YOUR FOCUS: IMPLEMENTATION ONLY**

The git workflow (branching, committing, pushing, PR creation) is handled automatically by the system. Your job is to focus solely on implementing the solution.

Follow these steps systematically:
1. Use \`gh issue view ${issueRef.number}\` to get the issue details
2. Use \`gh issue view ${issueRef.number} --comments\` to read all issue comments for additional context
3. **Pay attention to any images, screenshots, or attachments** in the issue description and comments - these often contain crucial visual information like UI mockups, error screenshots, or design specifications
4. Understand the complete problem described in the issue, comments, and any visual materials
5. Search the codebase to understand the current implementation
6. Implement the necessary changes to solve the issue
7. Test your implementation (if applicable and possible)
8. Ensure code follows existing patterns and conventions

**IMPORTANT NOTES:**
- **DO NOT** worry about git operations (add, commit, push, PR creation)
- **DO NOT** use git commands or GitHub CLI for workflow operations
- **FOCUS ONLY** on implementing the solution to the problem
- You are working in a git worktree environment with the codebase ready
- Make your changes directly to the files that need modification
- The system will automatically handle committing, pushing, and creating a PR
- Include a brief summary of what you implemented when you're done

**SUCCESS CRITERIA:**
Your task is complete when you have implemented a working solution to the issue. The git workflow and PR creation will be handled automatically by the system after your implementation.`;
    }

    /**
     * Validates that the provider is properly configured
     * @returns {Promise<boolean>} True if provider is ready to use
     */
    async validateConfiguration() {
        throw new Error('validateConfiguration method must be implemented by AI provider');
    }

    /**
     * Gets the default model for this provider
     * @returns {string} Default model name
     */
    getDefaultModel() {
        return this.supportedModels.length > 0 ? this.supportedModels[0] : null;
    }

    /**
     * Checks if a model is supported by this provider
     * @param {string} modelName - Model name to check
     * @returns {boolean} True if model is supported
     */
    supportsModel(modelName) {
        return this.supportedModels.includes(modelName);
    }

    /**
     * Gets the provider name
     * @returns {string} Provider name
     */
    getProviderName() {
        return this.providerName;
    }

    /**
     * Gets list of supported models
     * @returns {Array<string>} Array of supported model names
     */
    getSupportedModels() {
        return [...this.supportedModels];
    }

    /**
     * Builds any required infrastructure (e.g., Docker images) for the provider
     * @returns {Promise<boolean>} True if build was successful
     */
    async buildInfrastructure() {
        // Default implementation - no infrastructure needed
        return true;
    }
}

/**
 * AI Provider execution result interface
 * @typedef {Object} AIExecutionResult
 * @property {boolean} success - Whether execution was successful
 * @property {number} executionTime - Execution time in milliseconds
 * @property {Object} output - Provider-specific output data
 * @property {string} logs - Execution logs
 * @property {number} exitCode - Exit code (0 for success)
 * @property {string} rawOutput - Raw output from the AI
 * @property {Array} conversationLog - Conversation log (if supported)
 * @property {string} sessionId - Session ID (if supported)
 * @property {string} conversationId - Conversation ID (if supported)
 * @property {string} model - Model used for execution
 * @property {Object} finalResult - Final result object
 * @property {Array} modifiedFiles - List of modified files
 * @property {string} commitMessage - Suggested commit message
 * @property {string} summary - Summary of changes made
 * @property {string} error - Error message if execution failed
 */