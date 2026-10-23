/** A possibly billed request is never retried or redirected automatically. */
export class ApiError extends Error {
  readonly code = "api_no_retry";
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = "ApiError"; }
}
