import pg from 'pg';
import { env } from './env.js';

console.log("env ;;;;;;;", env);
const { Pool } = pg;

const pool = new Pool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});
pool.connect().then((client) => {
    console.log("[db] connected successfully");
    client.release();
}).catch((err) => {
    console.error("[db] error connecting", err);
});
// pool.on('error', (err) => {
//     console.error('[db] unexpected pool error', err);
// });

export default pool;
