import { describe, expect, it } from "vitest";
import {
  exportCancelled,
  exportFailed,
  isCancelled,
} from "../../src/job/errors";

describe("exportCancelled", () => {
  it("produces a ProblemDetails at status 499", () => {
    const result = exportCancelled();

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      status: 499,
      title: "Export Cancelled",
      detail: "The export was cancelled.",
    });
  });
});

describe("exportFailed", () => {
  it("defaults to status 500", () => {
    const result = exportFailed("Something went wrong");

    expect(result._unsafeUnwrapErr()).toMatchObject({
      status: 500,
      title: "Internal Server Error",
      detail: "Something went wrong",
    });
  });

  it("preserves an explicit status, including 403 which isn't registered by default", () => {
    const result = exportFailed("Root page read failed", 403);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      status: 403,
      title: "Forbidden",
      detail: "Root page read failed",
    });
  });
});

describe("isCancelled", () => {
  it("is true for a 499 problem", () => {
    expect(isCancelled(exportCancelled()._unsafeUnwrapErr())).toBe(true);
  });

  it("is false for any other status", () => {
    expect(isCancelled(exportFailed("boom", 403)._unsafeUnwrapErr())).toBe(
      false,
    );
  });
});
