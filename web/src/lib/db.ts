import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "[db] DATABASE_URL not set. Postgres calls will fail until provisioned.",
  );
}

// Each serverless instance gets its own pool; relying on Neon's pooler means
// we want at most one upstream connection per Lambda. Larger pools just burn
// Neon compute under burst load.
const sql = postgres(connectionString ?? "postgres://invalid", {
  ssl: connectionString?.includes("neon.tech") ? "require" : undefined,
  max: 1,
  idle_timeout: 20,
});

export default sql;
