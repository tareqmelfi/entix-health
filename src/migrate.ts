// EN-PRJ-VITA · Self-applying DB migrations (idempotent, fault-tolerant).
// Runs the canonical health_memory schema + auth + chat migrations at boot.
// Bundled SQL lives in /app/sql (copied into the image). Safe to run repeatedly:
// benign "already exists" / privilege errors are swallowed; real errors logged.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.resolve(__dirname, "../sql");

// duplicate_table, duplicate_object(trigger/extension), duplicate_schema,
// duplicate_function, undefined_object(role), insufficient_privilege,
// unique_violation(seed), feature_not_supported, undefined_function(ext missing)
const BENIGN = new Set(["42P07", "42710", "42P06", "42723", "42704", "42501", "23505", "0A000"]);

// Dollar-quote ($$..$$) and string-aware statement splitter.
function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let inString = false;
  let dollar: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        buf += dollar;
        i += dollar.length;
        dollar = null;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (inString) {
      buf += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          buf += "'";
          i += 2;
          continue;
        }
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      inString = true;
      buf += ch;
      i++;
      continue;
    }
    if (ch === "$") {
      const m = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (m) {
        dollar = m[0];
        buf += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (ch === ";") {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

export async function runMigrations(): Promise<{ applied: number; skipped: number; failed: number }> {
  const order = ["01-schema.sql", "02-auth.sql", "03-chat.sql"];
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS health_memory').catch(() => {});
    await client.query('SET search_path TO health_memory, public').catch(() => {});
    for (const file of order) {
      const full = path.join(sqlDir, file);
      if (!fs.existsSync(full)) {
        console.warn(`[migrate] missing ${file}`);
        continue;
      }
      const statements = splitSql(fs.readFileSync(full, "utf8"));
      for (const stmt of statements) {
        try {
          await client.query(stmt);
          applied++;
        } catch (error: any) {
          if (BENIGN.has(error?.code)) {
            skipped++;
          } else {
            failed++;
            console.warn("[migrate] stmt failed", error?.code, String(error?.message || "").slice(0, 140));
          }
        }
      }
    }
    console.log(`[migrate] done applied=${applied} skipped=${skipped} failed=${failed}`);
  } finally {
    client.release();
  }
  return { applied, skipped, failed };
}
