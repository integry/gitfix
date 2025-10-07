import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { getGitHubInstallationToken } from '../auth/githubAuth.js';

const CONFIG_REPO_URL = process.env.CONFIG_REPO || 'https://github.com/integry/gitfix-config.git';
const LOCAL_CONFIG_PATH = process.env.CONFIG_REPO_PATH || path.join(process.cwd(), '.config_repo');
const CONFIG_FILE_PATH = path.join(LOCAL_CONFIG_PATH, 'config.json');

export async function cloneOrPullConfigRepo() {
    try {
        const authToken = await getGitHubInstallationToken();
        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);

        if (await fs.pathExists(LOCAL_CONFIG_PATH)) {
            const git = simpleGit(LOCAL_CONFIG_PATH);
            try {
                await git.pull();
                logger.debug('Config repository pulled successfully');
            } catch (pullError) {
                // If pull fails (e.g., no remote branch yet), that's okay - we'll handle it in ensureConfigRepoExists
                logger.debug({ error: pullError.message }, 'Pull failed, repository may be empty');
            }
        } else {
            try {
                await simpleGit().clone(authenticatedUrl, LOCAL_CONFIG_PATH);
                logger.info('Config repository cloned successfully');
            } catch (cloneError) {
                // If clone fails because repo doesn't exist, create it locally
                if (cloneError.message.includes('Repository not found') || cloneError.message.includes('not found')) {
                    await fs.ensureDir(LOCAL_CONFIG_PATH);
                    const git = simpleGit(LOCAL_CONFIG_PATH);
                    await git.init();
                    await git.addRemote('origin', authenticatedUrl);
                    logger.info('Initialized new config repository locally');
                } else {
                    throw cloneError;
                }
            }
        }
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to clone or pull config repository');
        throw error;
    }
}

export async function loadMonitoredRepos() {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        let reposToMonitor = config.repos_to_monitor || [];

        if (reposToMonitor.length > 0 && typeof reposToMonitor[0] === 'string') {
            reposToMonitor = reposToMonitor.map(repo => ({ name: repo, enabled: true }));
        }

        const repos = reposToMonitor.filter(repo => repo.enabled).map(repo => repo.name);
        
        logger.info({ repos_to_monitor: repos, total_configured: reposToMonitor.length }, 'Successfully loaded enabled monitored repositories');
        return repos;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to load monitored repositories from config');
        throw error;
    }
}

export async function saveMonitoredRepos(repos, commitMessage = 'Update monitored repositories via UI') {
    try {
        await cloneOrPullConfigRepo();
        
        const config = await fs.readJson(CONFIG_FILE_PATH);
        config.repos_to_monitor = repos;
        
        await fs.writeJson(CONFIG_FILE_PATH, config, { spaces: 2 });

        const git = simpleGit(LOCAL_CONFIG_PATH);

        // Configure git user for commits if not already set
        try {
            await git.addConfig('user.email', 'gitfix@example.com');
            await git.addConfig('user.name', 'GitFix Bot');
        } catch (e) {
            // Config may already exist, ignore error
        }

        await git.add('config.json');
        await git.commit(commitMessage);

        const authToken = await getGitHubInstallationToken();
        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);
        await git.push(authenticatedUrl, 'main');
        
        logger.info({ repos }, 'Successfully saved and pushed monitored repositories');
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to save monitored repositories');
        throw error;
    }
}

export async function ensureConfigRepoExists() {
    try {
        await cloneOrPullConfigRepo();

        if (!await fs.pathExists(CONFIG_FILE_PATH)) {
            const initialConfig = {
                repos_to_monitor: []
            };

            await fs.writeJson(CONFIG_FILE_PATH, initialConfig, { spaces: 2 });

            const git = simpleGit(LOCAL_CONFIG_PATH);

            // Configure git user for commits
            await git.addConfig('user.email', 'gitfix@example.com');
            await git.addConfig('user.name', 'GitFix Bot');

            await git.add('config.json');
            await git.commit('Initialize config.json');

            const authToken = await getGitHubInstallationToken();
            const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);
            await git.push(authenticatedUrl, 'main');
            
            logger.info('Initialized config.json in config repository');
        }
        
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to ensure config repo exists');
        throw error;
    }
}
