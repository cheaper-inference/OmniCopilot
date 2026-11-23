export interface RequestErrorInfo {
  /** HTTP status, from the response or from an error reported inside the stream. */
  status?: number;
  /** How long the server asked the caller to wait before trying again. */
  retryAfterMs?: number;
  /** The server could not be reached at all (no HTTP answer). */
  network?: boolean;
}

/** A request the server rejected or could not be reached for. `info` is what
 * the retry logic and the connection indicator need; the message is for people. */
export class OmniRouteRequestError extends Error {
  constructor(
    message: string,
    readonly info: RequestErrorInfo,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
