/**
 * An in-memory SQLite with the real schema, for testing SQL builders in the
 * plain-Node suite. D1 is SQLite, so a statement's `changes` here is the row
 * count D1 would bill as written.
 *
 * node:sqlite is loaded through process.getBuiltinModule so Vite never tries to
 * resolve it; it needs Node >= 22.13 (CI pins 22). Null when unavailable, and
 * the suites using it skip rather than fail to load.
 */
const proc = (globalThis as any).process;
let mod: any = null;
try {
  mod = proc?.getBuiltinModule?.("node:sqlite") ?? null;
} catch {
  mod = null;
}
export const sqliteAvailable = !!mod;

export interface TestDb {
  run(sql: string, ...params: unknown[]): number;
  all<T = any>(sql: string, ...params: unknown[]): T[];
  get<T = any>(sql: string, ...params: unknown[]): T | undefined;
}

export function schemaDb(): TestDb {
  const fs = proc.getBuiltinModule("node:fs");
  const url = new URL("../../schema.sql", import.meta.url);
  const schema: string = fs.readFileSync(url, "utf8").replace(/--.*$/gm, "");
  const db = new mod.DatabaseSync(":memory:");
  for (const stmt of schema.split(";").map((s: string) => s.trim()).filter(Boolean)) db.exec(stmt);
  return {
    run: (sql, ...p) => Number(db.prepare(sql).run(...p).changes),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
  };
}
