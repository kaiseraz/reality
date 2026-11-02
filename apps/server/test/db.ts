import pg from 'pg';

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://reality:reality@localhost:5432/reality';
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://reality:reality@localhost:5432/reality_test';

/** Recreates the test database so every test file starts from an empty schema. */
export async function resetTestDatabase(): Promise<void> {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error(`Unsafe test db name: ${dbName}`);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
}
