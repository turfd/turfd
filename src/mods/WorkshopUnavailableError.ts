/** Thrown when workshop network operations run without a configured Supabase client. */

export class WorkshopUnavailableError extends Error {
  readonly name = "WorkshopUnavailableError";

  constructor(message = "Workshop requires a configured online account.") {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
