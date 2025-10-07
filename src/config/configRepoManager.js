import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';

const CONFIG_REPO_URL = process.env.CONFIG_REPO || 'https://github.com/integry/gitfix-config.git';
const LOCAL_CONFIG_PATH = path.join(process.cwd(), '.config_repo');
const CONFIG_FILE_PATH = path.join(LOCAL_CONFIG_PATH, 'config.json');

export async function cloneOrPullConfigRepo() {
    try {
        const authToken = process.env.GH_TOKEN;
        if (!authToken) {
            throw new Error('GH_TOKEN environment variable is required for config repo access');
        }

        const authenticatedUrl = CONFIG_REPO_URL.replace('https://', `https://x-access-token:${authToken}@`);

        if (await fs.pathExists(LOCAL_CONFIG_PATH)) {
            const git = simpleGit(LOCAL_CONFIG_PATH);
            await git.pull();
            logger.debug('Config repository pulled successfully');
        } else {
            await simpleGit().clone(authenticatedUrl, LOCAL_CONFIG_PATH);
            logger.info('Config repository cloned successfully');
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
        const repos = config.repos_to_monitor || [];
        
        logger.info({ repos }, 'Successfully loaded monitored repositories');
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
        await git.add('config.json');
        await git.commit(commitMessage);
        
        const authToken = process.env.GH_TOKEN;
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
            await git.add('config.json');
            await git.commit('Initialize config.json');
            
            const authToken = process.env.GH_TOKEN;
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
