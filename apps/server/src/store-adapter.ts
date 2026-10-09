import type { Db, Collection, Document } from "mongodb";
import type { CollectionLike, StoreLike } from "@porchlight/shared";

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