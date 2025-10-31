import 'dotenv/config';

const config = {
  development: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'gitfix_user',
      password: process.env.DB_PASSWORD || 'gitfix_password',
      database: process.env.DB_NAME || 'gitfix_history'
    },
    migrations: {
      directory: './src/db/migrations',
      tableName: 'knex_migrations'
    },
    pool: {
      min: 2,
      max: 10
    }
  },

  production: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'db',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    },
    migrations: {
      directory: './src/db/migrations',
      tableName: 'knex_migrations'
    },
    pool: {
      min: 2,
      max: 20
    }
  }
};

export default config;
