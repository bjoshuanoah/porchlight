import { MongoClient, type Db } from "mongodb";
import { createClient, type RedisClientType } from "redis";
import type { PorchlightConfig } from "@porchlight/shared";

export type ProbeResult = "ok" | "down";
export type Probe = () => Promise<ProbeResult>;

export interface Dependencies {
  db: Db;
  redis: RedisClientType;
  /** Live dependency probes the health surface reports to the owner dashboard. */
  readiness: { mongo: Probe; redis: Probe };
}

/**
 * Dependency connectors for the hub runtime: Mongo (all domains, same
 * machine) and Redis (sessions, upload queues, notification fanout) bound to
 * the installer-managed daemon ports from the runtime config.
 */
export async function connectDependencies(
  config: PorchlightConfig,
  options: { serverSelectionTimeoutMs?: number } = {},
): Promise<Dependencies> {
  const serverSelectionTimeoutMs = options.serverSelectionTimeoutMs ?? 120_000;
  const mongoClient = new MongoClient(
    `mongodb://127.0.0.1:${config.daemons.mongoPort}/porchlight?directConnection=true`,
    { serverSelectionTimeoutMS: serverSelectionTimeoutMs },
  );
  const db = mongoClient.db();

  const redis: RedisClientType = createClient({ url: `redis://127.0.0.1:${config.daemons.redisPort}` });
  redis.on("error", () => {
    /* errors surface through the readiness probe, not a crash */
  });
  await redis.connect();

  return {
    db,
    redis,
    readiness: {
      mongo: probe(async () => void (await db.command({ ping: 1 }))),
      redis: probe(async () => void (await redis.ping())),
    },
  };
}

/** Wrap a throwing check into an ok/down probe; a false result is "down". */
export function probe(check: () => Promise<unknown>): Probe {
  return async () => {
    try {
      const result = await check();
      return result === false ? "down" : "ok";
    } catch {
      return "down";
    }
  };
}