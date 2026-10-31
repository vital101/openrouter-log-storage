// Creates a scratch benchmark database. Usage: node bench/setup-db.mjs
import { Client } from "pg";
import { readFileSync } from "node:fs";

const env = readFileSync(".env", "utf8")
  .split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#"))
  .map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  });
const get = (k) => env.find(([key]) => key === k)?.[1] || process.env[k];

const adminUrl = new URL(get("DATABASE_URL"));
adminUrl.pathname = "/postgres";
const dbName = "openrouter_logs_bench";

const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
if (exists.rowCount === 0) {
  await admin.query(`CREATE DATABASE ${dbName}`);
  console.log("created", dbName);
} else {
  console.log("exists", dbName);
}
await admin.end();
