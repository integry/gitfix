import 'dotenv/config';

const config = {
    github: {
        appId: process.env.GH_APP_ID,
        privateKeyPath: process.env.GH_PRIVATE_KEY_PATH,
        installationId: process.env.GH_INSTALLATION_ID,
    },
    logging: {
        level: process.env.LOG_LEVEL || 'info',
    },
    environment: process.env.NODE_ENV || 'development',
};

export default config;