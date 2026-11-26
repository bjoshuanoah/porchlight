import type { Db, Collection, Document, Filter } from "mongodb";
import type { CollectionLike, StoreLike } from "@porchlight/shared";
import type { MigrationCollectionLike, MigrationStore, MigrationWrite } from "./services/migration.service.js";

/**
 * Adapter from the realtime mongodb driver's Db to the minimal store
 * interface the modules and services consume. Typed once at the boot
 * boundary so every service keeps a narrow, substitutable surface.
 *
 * Identity and social each own their collections exclusively; the adapter
 * never decides domain behavior.
 */
export function mongoStore(db: Db): StoreLike {
  const collection = (name: string): CollectionLike => {
    const raw: Collection<Document> = db.collection(name);
    return {
      async findOne(filter: Record<string, unknown> = {}) {
        return (await raw.findOne(filter)) ?? null;
      },
      async find(filter: Record<string, unknown> = {}) {
        return await raw.find(filter).toArray();
      },
      async insertOne(document: Record<string, unknown>) {
        const result = await raw.insertOne(document as Document);
        return { insertedId: result.insertedId };
      },
      async updateOne(filter: Record<string, unknown>, update: { $set?: Record<string, unknown>; upsert?: boolean }) {
        const result = await raw.updateOne(filter, { $set: update.$set ?? {} }, { upsert: update.upsert ?? false });
        return { matchedCount: result.matchedCount, upsertedId: result.upsertedId };
      },
      async deleteOne(filter: Record<string, unknown> = {}) {
        const result = await raw.deleteOne(filter);
        return { deletedCount: result.deletedCount };
      },
      async deleteMany(filter: Record<string, unknown> = {}) {
        const result = await raw.deleteMany(filter);
        return { deletedCount: result.deletedCount };
      },
    };
  };
  return { collection };
}

/**
 * Adapter for the migration runner's store surface (PORCH-156). The one
 * place the raw driver's wider semantics (arbitrary filters, `$unset`,
 * bulk writes) belong: domain services keep their narrow `CollectionLike`;
 * only migrations reach through this.
 */
export function mongoMigrationStore(db: Db): MigrationStore {
  return {
    collection(name: string): MigrationCollectionLike {
      const raw: Collection<Document> = db.collection(name);
      return {
        async find(filter: Record<string, unknown> = {}) {
          return (await raw.find(filter as Filter<Document>).toArray()) as unknown as Array<Record<string, unknown>>;
        },
        async insertOne(document: Record<string, unknown>) {
          const result = await raw.insertOne(document as Document);
          return result.insertedId;
        },
        async updateOne(filter: Record<string, unknown>, update: MigrationWrite, options: { upsert?: boolean } = {}) {
          const result = await raw.updateOne(filter as Filter<Document>, update as Document, {
            upsert: options.upsert ?? false,
          });
          return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
        },
        async updateMany(filter: Record<string, unknown>, update: MigrationWrite) {
          const result = await raw.updateMany(filter as Filter<Document>, update as Document);
          return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
        },
        async countDocuments(filter: Record<string, unknown> = {}) {
          return await raw.countDocuments(filter as Filter<Document>);
        },
      };
    },
  };
}