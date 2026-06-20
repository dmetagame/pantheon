import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required to run migrations.");
  process.exit(1);
}

const sql = postgres(connectionString, {
  ssl: connectionString.includes("neon.tech") ? "require" : undefined,
  max: 1,
});

async function run() {
  const dir = join(process.cwd(), "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sqlText = await readFile(join(dir, file), "utf-8");
    console.log(`▸ applying ${file}`);
    await sql.unsafe(sqlText);
  }
  console.log("✓ migrations complete");
  await sql.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
