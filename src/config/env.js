import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const env = {
  port: parseInt(process.env.PORT || '5000', 10),
  host: process.env.HOST || 'localhost',

  jwt: {
    secret: required('JWT_SECRET'),
    issuer: process.env.JWT_ISSUER || 'pibot',
    ttlMin: parseInt(process.env.JWT_ACCESS_TTL_MIN || '1440', 10),
  },

  db: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    user:     required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
    ssl:      (process.env.DB_SSL || 'disable') !== 'disable',
  },

  // base64-encoded 32-byte AES-256 key — same as Go's WALLET_ENCRYPTION_KEY
  walletEncryptionKey: required('WALLET_ENCRYPTION_KEY'),
};
