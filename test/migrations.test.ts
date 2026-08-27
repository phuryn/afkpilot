/**
 * The migrations, read as text.
 *
 * Nothing here talks to a database. It exists because a migration is the one
 * artifact in this repo whose failure is SILENT to every other test: the suite
 * is green, the relay builds, the deploy succeeds, and the table simply is not
 * there. That is not hypothetical — `environments` shipped with
 * `device_id text` referencing `devices.device_id uuid`, Postgres refused the
 * whole statement, and the first anyone knew was a 404 from PostgREST days
 * later. Worse than a missing table: a failed migration queues every later one
 * behind it.
 *
 * So these are the properties a migration can be wrong about in a way that
 * costs a deploy, checked by parsing rather than by running.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

/** `col type ...` inside a create-table body, comments and blanks dropped. */
const COLUMN = /^\s*([a-z_][a-z0-9_]*)\s+([a-z][a-z0-9_]*)\b(.*)$/;
const REFERENCES = /references\s+public\.([a-z_][a-z0-9_]*)\s*\(\s*([a-z_][a-z0-9_]*)\s*\)/i;
const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_][a-z0-9_]*)\s*\(/i;

interface Column {
  table: string;
  name: string;
  type: string;
  refTable?: string;
  refColumn?: string;
  file: string;
}

/**
 * Walk every migration once and collect declared columns.
 *
 * Deliberately dumb: it reads what the files SAY, in file order, the way the
 * migration runner applies them. A cleverer parser would be a second thing that
 * can disagree with Postgres.
 */
function columns(): Column[] {
  const out: Column[] = [];
  for (const file of files) {
    const sql = readFileSync(join(DIR, file), "utf8");
    let table: string | null = null;
    let depth = 0;
    for (const raw of sql.split(/\r?\n/)) {
      const line = raw.replace(/--.*$/, "");
      if (!table) {
        const start = CREATE_TABLE.exec(line);
        if (start) {
          table = start[1];
          depth = 1;
        }
        continue;
      }
      // Column lines only: anything after the body's closing paren is a
      // constraint or another statement, not a column.
      const opens = (line.match(/\(/g) ?? []).length;
      const closes = (line.match(/\)/g) ?? []).length;
      const wasTopLevel = depth === 1;
      depth += opens - closes;
      if (depth <= 0) {
        table = null;
        continue;
      }
      if (!wasTopLevel) continue;
      const m = COLUMN.exec(line);
      if (!m) continue;
      const ref = REFERENCES.exec(m[3]);
      out.push({
        table,
        name: m[1],
        type: m[2],
        refTable: ref?.[1],
        refColumn: ref?.[2],
        file,
      });
    }
  }
  return out;
}

const ALL = columns();

describe("reading the migrations at all", () => {
  it("finds the tables this relay is built on", () => {
    // A guard on the parser, not the schema. If a rewrite makes it stop seeing
    // columns, every assertion below would pass vacuously.
    const tables = new Set(ALL.map((c) => c.table));
    expect(tables).toContain("devices");
    expect(tables).toContain("environments");
    expect(ALL.length).toBeGreaterThan(10);
  });
});

describe("foreign keys", () => {
  it("reference a column that exists", () => {
    for (const col of ALL) {
      if (!col.refTable) continue;
      const target = ALL.find((c) => c.table === col.refTable && c.name === col.refColumn);
      expect(
        target,
        `${col.file}: ${col.table}.${col.name} references ${col.refTable}.${col.refColumn}, which is not declared`,
      ).toBeDefined();
    }
  });

  it("declare the same type as the column they reference", () => {
    // THE ONE THAT WAS WRONG. Postgres does not coerce here and does not warn:
    // "key columns are of incompatible types" aborts the statement, so the
    // table is never created and the deploy still reports success.
    for (const col of ALL) {
      if (!col.refTable) continue;
      const target = ALL.find((c) => c.table === col.refTable && c.name === col.refColumn);
      if (!target) continue;
      expect(
        col.type,
        `${col.file}: ${col.table}.${col.name} is ${col.type} but references `
        + `${col.refTable}.${col.refColumn}, which is ${target.type}`,
      ).toBe(target.type);
    }
  });
});

describe("the standing patterns", () => {
  it("enables row level security on every table", () => {
    // RLS on with zero policies is deny-all: only the relay's secret key
    // touches the database. A table that forgets it is readable by anyone
    // holding the publishable key.
    const declared = new Set(ALL.map((c) => c.table));
    const sql = files.map((f) => readFileSync(join(DIR, f), "utf8")).join("\n");
    for (const table of declared) {
      expect(
        sql,
        `public.${table} never enables row level security`,
      ).toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"));
    }
  });

  it("is ordered by a timestamp prefix, with no duplicates", () => {
    // The runner applies them in filename order. Two files sharing a prefix is
    // an ordering nobody chose.
    const prefixes = files.map((f) => f.slice(0, 14));
    for (const p of prefixes) expect(p).toMatch(/^\d{14}$/);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("creates tables and indexes idempotently", () => {
    // Re-running a migration must not be an error: an integration that retries
    // after a partial failure would otherwise never converge.
    for (const file of files) {
      const sql = readFileSync(join(DIR, file), "utf8").replace(/--.*$/gm, "");
      for (const stmt of sql.match(/create\s+(table|index)[\s\S]*?;/gi) ?? []) {
        expect(stmt.slice(0, 80), `${file}: ${stmt.slice(0, 60).trim()}`).toMatch(/if\s+not\s+exists/i);
      }
    }
  });
});
