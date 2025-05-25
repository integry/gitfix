# GitFix - Automated GitHub Issue Processor

An automated system that monitors GitHub issues, uses Anthropic's Claude Code to generate solutions, and automates the Git workflow including PR creation.

## Current Implementation

### Stage 1: Authentication, Logging & Project Setup
✅ Foundational components for the automated GitHub issue processor

### Stage 2: GitHub Issue Detection Daemon
✅ Daemon that polls GitHub repositories for AI-eligible issues

### Stage 3: Task Queue and Worker Infrastructure
✅ BullMQ-based task queue with Redis for managing detected issues
✅ Worker processes that tag issues and prepare for AI processing

### Stage 4: Git Environment Management
✅ Repository cloning and updating with authentication
✅ Git worktree creation for isolated issue processing
✅ Branch management and cleanup automation

## Prerequisites

- Node.js 18+ installed
- GitHub App created with appropriate permissions
- Claude Max plan subscription
- Redis server running (for task queue)
- Git installed (version 2.25+ recommended for worktree support)
- Sufficient disk space for repository clones and worktrees

## Setup

### 1. GitHub App Configuration

Create a GitHub App with the following permissions:

**Repository Permissions:**
- Contents: Read & Write
- Metadata: Read
- Issues: Read & Write
- Pull requests: Read & Write

**Installation:**
1. Create a new GitHub App in your account/organization settings
2. Generate and download the private key (`.pem` file)
3. Install the app on your repository
4. Note down the App ID and Installation ID

### 2. Environment Configuration

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Fill in your credentials and daemon configuration:
   ```
   # GitHub App Configuration
   GH_APP_ID=your_app_id
   GH_PRIVATE_KEY_PATH=./your-app-private-key.pem
   GH_INSTALLATION_ID=your_installation_id
   
   # Daemon Configuration
   GITHUB_REPOS_TO_MONITOR=owner/repo1,owner/repo2
   POLLING_INTERVAL_MS=60000
   
   # Issue Detection Configuration
   AI_PRIMARY_TAG=AI
   AI_EXCLUDE_TAGS_PROCESSING=AI-processing
   AI_EXCLUDE_TAGS_DONE=AI-done
   
   # Git Configuration
   GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
   GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees
   GIT_DEFAULT_BRANCH=main
   GIT_SHALLOW_CLONE_DEPTH=
   ```

3. Place your GitHub App private key file in the project root

### 3. Git Environment Setup

Ensure the worker can access repository storage directories:

```bash
# Create directories with appropriate permissions
sudo mkdir -p /tmp/git-processor/{clones,worktrees}
sudo chown -R $(whoami) /tmp/git-processor
chmod 755 /tmp/git-processor

# Verify Git installation and worktree support
git --version
git worktree --help
```

### 4. Claude Authentication

For Claude Code CLI access:

1. Ensure you have a Claude Max subscription
2. Run `claude login` on your local machine
3. This generates `~/.config/claude-code/auth.json`
4. This file will be used for non-interactive Claude Code execution in later stages

### 4. Installation

```bash
npm install
```

## Project Structure

```
gitfix/
├── src/
│   ├── auth/
│   │   └── githubAuth.js    # GitHub App authentication
│   ├── utils/
│   │   ├── errorHandler.js  # Error handling utilities
│   │   └── logger.js        # Structured logging utility
│   ├── daemon.js            # Issue detection daemon
│   └── index.js             # Example usage
├── config/
│   └── index.js             # Configuration management
├── test/                    # Test files
├── scripts/                 # Future automation scripts
├── .env.example            # Example environment variables
├── .gitignore             # Git ignore patterns
└── package.json           # Project dependencies
```

## Usage

### Running the Issue Detection Daemon

Start the daemon to monitor GitHub repositories for AI-eligible issues:

```bash
# Production mode
npm run daemon

# Development mode with debug logging
npm run daemon:dev
```

The daemon will:
- Poll configured repositories at the specified interval
- Search for open issues with the AI tag
- Exclude issues already being processed or completed
- Add detected issues to the task queue for processing

### Running the Worker Process

Start one or more workers to process issues from the queue:

```bash
# Production mode
npm run worker

# Development mode with debug logging
npm run worker:dev

# Run multiple workers (in separate terminals)
npm run worker & npm run worker
```

The worker will:
- Pull jobs from the Redis-backed task queue
- Add "AI-processing" tag to issues being worked on
- Post a comment indicating processing has started
- Prepare for future Claude Code integration

### GitHub Authentication

```javascript
import { getAuthenticatedOctokit } from './src/auth/githubAuth.js';

const octokit = await getAuthenticatedOctokit();
// Use octokit for GitHub API operations
```

### Logging

```javascript
import logger from './src/utils/logger.js';

logger.info('Application started');
logger.error('An error occurred', { error: err });
logger.debug('Debug information', { data: someData });
```

### Configuration

```javascript
import config from './config/index.js';

console.log(config.github.appId);
console.log(config.logging.level);
```

## Redis Setup

The task queue requires Redis. Install and start Redis:

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis

# Docker
docker run -d -p 6379:6379 redis:alpine
```

## Error Handling

The project implements consistent error handling patterns:

1. All async operations use try-catch blocks
2. Errors are logged with full context
3. Critical configuration errors cause early exit
4. Non-critical errors are handled gracefully
5. Queue jobs retry automatically with exponential backoff

## Security Best Practices

- **Never commit sensitive credentials** to the repository
- Store all secrets in environment variables
- Keep the GitHub App private key file secure with restricted permissions
- Use `.gitignore` to prevent accidental commits of sensitive files

## Testing

Run tests with:
```bash
npm test
```

## Next Steps

Future issues in this epic will implement:
- ✅ Issue detection and monitoring (Stage 2)
- ✅ Task queuing system (Stage 3)
- Git environment management
- Claude Code integration
- Automated PR creation
- Pre-PR checks and validation

## Contributing

When contributing to this project:
1. Follow existing code patterns and conventions
2. Ensure all tests pass
3. Update documentation as needed
4. Use the structured logger for all output
5. Handle errors consistently