/** In-memory migration store for tests: honest match/update semantics over
 * the filter subset the runner and its steps use ($or, $ne, $exists, flat
 * equality, $set/$unset writes), plus per-operation counters. */
import type {
  MigrationCollectionLike,
  MigrationStore,
  MigrationWrite,
} from "../../src/services/migration.service.js";

export type Row = Record<string, unknown>;

function valuesEqual(a: unknown, b: unknown): boolean {
  const nullA = a === undefined || a === null;
  const nullB = b === undefined || b === null;
  if (nullA || nullB) return nullA && nullB;
  return a === b;
}

function matchesFilter(doc: Row, filter: Row): boolean {
  if (filter.$or !== undefined) {
    return (filter.$or as Row[]).some((sub) => matchesFilter(doc, sub));
  }
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "_id") return valuesEqual(doc._id, cond);
    const value = doc[key];
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      return Object.entries(cond as Row).every(([op, operand]) => {
        if (op === "$ne") return !valuesEqual(value, operand);
        if (op === "$exists") return operand ? value !== undefined : value === undefined;
        throw new Error(`test matcher supports only $ne/$exists, got ${op}`);
      });
    }
    if (cond === null) return valuesEqual(value, null);
    return valuesEqual(value, cond);
  });
}

export function fakeMigrationStore(seed: Record<string, Row[]> = {}) {
  const data = new Map<string, Row[]>(Object.entries(seed).map(([name, rows]) => [name, [...rows]]));
  const ops: Record<string, { find: number; updateOne: number; inserts: number }> = {};
  const collection = (name: string): MigrationCollectionLike => {
    ops[name] ??= { find: 0, updateOne: 0, inserts: 0 };
    if (!data.has(name)) data.set(name, []);
    const rows = data.get(name) as Row[];
    return {
      async find(filter: Row = {}) {
        ops[name].find += 1;
        return rows.filter((row) => matchesFilter(row, filter)).map((row) => ({ ...row }));
      },
      async insertOne(document: Row) {
        ops[name].inserts += 1;
        rows.push({ ...document });
        return document._id ?? null;
      },
      async updateOne(filter: Row, update: MigrationWrite, options: { upsert?: boolean } = {}) {
        ops[name].updateOne += 1;
        const index = rows.findIndex((row) => matchesFilter(row, filter));
        if (index === -1) {
          if (options.upsert) {
            const doc: Row = structuredClone(filter);
            for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
            rows.push(doc);
          }
          return { matchedCount: 0, modifiedCount: 0 };
        }
        const doc = rows[index];
        for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
        for (const k of Object.keys(update.$unset ?? {})) delete doc[k];
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async updateMany(filter: Row, update: MigrationWrite) {
        let matched = 0;
        for (const doc of rows) {
          if (!matchesFilter(doc, filter)) continue;
          matched += 1;
          for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
          for (const k of Object.keys(update.$unset ?? {})) delete doc[k];
        }
        return { matchedCount: matched, modifiedCount: matched };
      },
      async countDocuments(filter: Row = {}) {
        return rows.filter((row) => matchesFilter(row, filter)).length;
      },
    };
  };
  return {
    store: { collection } satisfies MigrationStore,
    rows: (name: string): Row[] => data.get(name) ?? [],
    data,
    ops,
  };
}
