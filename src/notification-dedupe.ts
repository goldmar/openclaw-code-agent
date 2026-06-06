import type { SessionNotificationDedupeRecord } from "./types";

export interface NotificationDedupeCoordinatorOptions {
  maxRecords?: number;
  inFlightTtlMs?: number;
  now?: () => Date;
}

export interface NotificationDedupeClaim {
  allowed: boolean;
  records?: SessionNotificationDedupeRecord[];
  reason?: string;
}

const DEFAULT_MAX_RECORDS = 64;
const DEFAULT_IN_FLIGHT_TTL_MS = 10 * 60 * 1000;

export const DUPLICATE_NOTIFICATION_SKIP_REASON =
  "duplicate notification already delivered or in flight";

export class NotificationDedupeCoordinator {
  private readonly maxRecords: number;
  private readonly inFlightTtlMs: number;
  private readonly now: () => Date;
  private readonly inFlight = new Set<string>();
  private readonly delivered = new Set<string>();

  constructor(options: NotificationDedupeCoordinatorOptions = {}) {
    this.maxRecords = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS));
    this.inFlightTtlMs = Math.max(1, Math.floor(options.inFlightTtlMs ?? DEFAULT_IN_FLIGHT_TTL_MS));
    this.now = options.now ?? (() => new Date());
  }

  claim(
    key: string | undefined,
    persistedRecords: SessionNotificationDedupeRecord[] | undefined,
    label: string,
  ): NotificationDedupeClaim {
    if (!key) return { allowed: true };

    const now = this.now();
    const records = this.prune(persistedRecords ?? [], now);
    const persistedRecord = records.find((record) => record.key === key);
    if (
      this.delivered.has(key)
      || this.inFlight.has(key)
      || persistedRecord?.status === "delivered"
      || (persistedRecord?.status === "in_flight" && this.isFreshInFlight(persistedRecord, now))
    ) {
      return {
        allowed: false,
        records,
        reason: DUPLICATE_NOTIFICATION_SKIP_REASON,
      };
    }

    this.inFlight.add(key);
    this.delivered.delete(key);
    return {
      allowed: true,
      records: this.upsert(records, {
        key,
        status: "in_flight",
        recordedAt: now.toISOString(),
        label,
      }),
    };
  }

  deliveredRecords(
    key: string | undefined,
    persistedRecords: SessionNotificationDedupeRecord[] | undefined,
    label: string,
  ): SessionNotificationDedupeRecord[] | undefined {
    if (!key) return undefined;
    const now = this.now();
    this.inFlight.delete(key);
    this.delivered.add(key);
    return this.upsert(this.prune(persistedRecords ?? [], now), {
      key,
      status: "delivered",
      recordedAt: now.toISOString(),
      label,
    });
  }

  releasedRecords(
    key: string | undefined,
    persistedRecords: SessionNotificationDedupeRecord[] | undefined,
  ): SessionNotificationDedupeRecord[] | undefined {
    if (!key) return undefined;
    const now = this.now();
    this.inFlight.delete(key);
    return this.prune(persistedRecords ?? [], now).filter((record) => {
      return !(record.key === key && record.status === "in_flight");
    });
  }

  private prune(records: SessionNotificationDedupeRecord[], now: Date): SessionNotificationDedupeRecord[] {
    const pruned = records.filter((record) => {
      if (record.status === "delivered") return true;
      return this.isFreshInFlight(record, now);
    });
    return pruned.slice(Math.max(0, pruned.length - this.maxRecords));
  }

  private isFreshInFlight(record: SessionNotificationDedupeRecord, now: Date): boolean {
    const recordedAt = Date.parse(record.recordedAt);
    if (!Number.isFinite(recordedAt)) return false;
    return now.getTime() - recordedAt < this.inFlightTtlMs;
  }

  private upsert(
    records: SessionNotificationDedupeRecord[],
    next: SessionNotificationDedupeRecord,
  ): SessionNotificationDedupeRecord[] {
    const withoutKey = records.filter((record) => record.key !== next.key);
    const capped = [...withoutKey, next];
    return capped.slice(Math.max(0, capped.length - this.maxRecords));
  }
}
