import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "[db] DATABASE_URL not set. Postgres calls will fail until provisioned.",
  );
}

const sql = postgres(connectionString ?? "postgres://invalid", {
  ssl: connectionString?.includes("neon.tech") ? "require" : undefined,
  max: 5,
  idle_timeout: 20,
});

export default sql;
