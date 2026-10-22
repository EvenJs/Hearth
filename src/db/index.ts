import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema.ts';

// 用 WebSocket Pool（neon-serverless），不用 neon-http：CSV 导入需要事务
neonConfig.webSocketConstructor = ws;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL 没有设置，检查 .env.local');
}

export const pool = new Pool({ connectionString });
export const db = drizzle({ client: pool, schema });
