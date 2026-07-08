import {
  type ProblemDetails,
  type Result,
  StandardError,
} from "@forge-ahead/errors";

// Confluence returns 403 for permission-restricted content; not one of the
// codes @forge-ahead/errors registers by default (400, 401, 404, 415, 416,
// 422, 500, 502, 503, 507).
StandardError.add(403, "Forbidden");

// There's no official HTTP status for "the caller cancelled the operation".
// 499 (Client Closed Request) is the de facto convention for it -- using it
// lets cancellation flow through the same Result<T, ProblemDetails> channel
// as every other export failure, rather than needing a separate exception
// type that every caller has to know to catch specially.
export const CANCELLED_STATUS = 499;
StandardError.add(CANCELLED_STATUS, "Export Cancelled");

export function exportCancelled(): Result<never, ProblemDetails> {
  return StandardError.getOrDefault(CANCELLED_STATUS).error(
    "The export was cancelled.",
  );
}

export function exportFailed(
  message: string,
  status = 500,
): Result<never, ProblemDetails> {
  return StandardError.getOrDefault(status).error(message);
}

export function isCancelled(problem: ProblemDetails): boolean {
  return problem.status === CANCELLED_STATUS;
}
