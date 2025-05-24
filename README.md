# GitFix - Automated GitHub Issue Processor

An automated system that monitors GitHub issues, uses Anthropic's Claude Code to generate solutions, and automates the Git workflow including PR creation.

## Stage 1: Authentication, Logging & Project Setup

This initial implementation establishes the foundational components for the automated GitHub issue processor.

## Prerequisites

- Node.js 18+ installed
- GitHub App created with appropriate permissions
- Claude Max plan subscription

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

2. Fill in your GitHub App credentials:
   ```
   GH_APP_ID=your_app_id
   GH_PRIVATE_KEY_PATH=./your-app-private-key.pem
   GH_INSTALLATION_ID=your_installation_id
   ```

3. Place your GitHub App private key file in the project root

### 3. Claude Authentication

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
│   └── utils/
│       └── logger.js         # Structured logging utility
├── config/
│   └── index.js             # Configuration management
├── scripts/                 # Future automation scripts
├── .env.example            # Example environment variables
├── .gitignore             # Git ignore patterns
└── package.json           # Project dependencies
```

## Usage

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

## Error Handling

The project implements consistent error handling patterns:

1. All async operations use try-catch blocks
2. Errors are logged with full context
3. Critical configuration errors cause early exit
4. Non-critical errors are handled gracefully

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
- Issue detection and monitoring
- Task queuing system
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