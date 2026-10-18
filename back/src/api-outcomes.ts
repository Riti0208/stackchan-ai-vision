export class PaidSessionStopped extends Error {
  readonly reason: string;
  constructor(reason: string, message = `Paid API session stopped: ${reason}`) { super(message); this.name = 'PaidSessionStopped'; this.reason = reason; }
}
