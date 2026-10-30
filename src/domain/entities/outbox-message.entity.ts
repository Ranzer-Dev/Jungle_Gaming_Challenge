import { IntegrationEvent } from "../events/integration-event.base";

export interface OutboxMessageProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt?: Date;
  attempts?: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  public static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  public static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  public get attempts(): number {
    return this._attempts;
  }

  public get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  public get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  public isPending(): boolean {
    return this._publishedAt === undefined;
  }

  public isDue(now: Date = new Date()): boolean {
    if (!this.isPending()) {
      return false;
    }
    if (!this._nextAttemptAt) {
      return true;
    }
    return this._nextAttemptAt <= now;
  }

  public markPublished(at: Date = new Date()): void {
    this._publishedAt = at;
  }

  public scheduleRetry(now: Date = new Date()): void {
    this._attempts += 1;
    // Exponential backoff com jitter aleatório (ADR-005)
    // t_wait = min(30s, 0.1s * 2^attempts) +/- 20% jitter
    const baseWaitMs = 100 * Math.pow(2, this._attempts);
    const clampedWaitMs = Math.min(30000, baseWaitMs);
    const jitterFactor = 0.8 + Math.random() * 0.4; // 0.8 a 1.2
    const finalWaitMs = Math.round(clampedWaitMs * jitterFactor);

    this._nextAttemptAt = new Date(now.getTime() + finalWaitMs);
  }
}

