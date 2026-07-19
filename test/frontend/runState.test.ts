import { describe, expect, it } from "vitest";
import {
  createInitialExecutionUiRunState,
  isErrorResult,
  messageFor,
  selectExecutionUiRunView,
  transitionExecutionUiRunState,
  type ExecutionUiRunState,
  type ExportJobView,
  type StartExportInput,
} from "../../src/frontend/runState";

const startInput: StartExportInput = {
  rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
  depth: 5,
  bundleSlug: "root",
};

function makeJob(overrides: Partial<ExportJobView> = {}): ExportJobView {
  return {
    jobId: "job-1",
    status: "running",
    stage: "fetching-pages",
    bundleSlug: "root",
    exportedCount: 3,
    skipped: [],
    ...overrides,
  };
}

function stateWithJob(
  job = makeJob(),
  overrides: Partial<ExecutionUiRunState> = {},
): ExecutionUiRunState {
  return {
    ...createInitialExecutionUiRunState(),
    job,
    ...overrides,
  };
}

describe("transitionExecutionUiRunState start flow", () => {
  it("requests an export and turns a job id into an optimistic queued job", () => {
    const requested = transitionExecutionUiRunState(
      createInitialExecutionUiRunState(),
      { type: "start-requested", input: startInput },
    );

    expect(requested.state).toMatchObject({
      starting: true,
      startError: null,
      backgroundError: null,
      downloadUrl: null,
    });
    expect(requested.effects).toEqual([
      { type: "start-export", input: startInput },
    ]);

    const started = transitionExecutionUiRunState(requested.state, {
      type: "start-succeeded",
      jobId: "job-1",
      bundleSlug: "root",
    });

    expect(started.state).toMatchObject({
      starting: false,
      job: {
        jobId: "job-1",
        status: "queued",
        stage: "fetching-pages",
        bundleSlug: "root",
        exportedCount: 0,
        skipped: [],
      },
    });
    expect(started.effects).toEqual([
      { type: "start-polling", jobId: "job-1" },
    ]);
  });

  it("keeps start failures on the pre-job error slot", () => {
    const state = {
      ...createInitialExecutionUiRunState(),
      starting: true,
    };

    const transition = transitionExecutionUiRunState(state, {
      type: "start-failed",
      message: "Root page is required.",
    });

    expect(transition.state).toMatchObject({
      starting: false,
      startError: "Root page is required.",
      backgroundError: null,
      job: null,
    });
    expect(transition.effects).toEqual([]);
  });
});

describe("transitionExecutionUiRunState resume and polling", () => {
  it("resumes a running job by restarting polling", () => {
    const transition = transitionExecutionUiRunState(
      createInitialExecutionUiRunState(),
      { type: "resume-succeeded", job: makeJob({ jobId: "job-9" }) },
    );

    expect(transition.state.job?.jobId).toBe("job-9");
    expect(transition.effects).toEqual([
      { type: "start-polling", jobId: "job-9" },
    ]);
  });

  it("stops polling and requests a download link when a job becomes ready", () => {
    const transition = transitionExecutionUiRunState(
      stateWithJob(makeJob({ status: "running" })),
      {
        type: "poll-succeeded",
        job: makeJob({ status: "ready", stage: "ready" }),
      },
    );

    expect(transition.state.downloadRequestedForJobId).toBe("job-1");
    expect(transition.effects).toEqual([
      { type: "stop-polling" },
      { type: "create-download-url", jobId: "job-1" },
    ]);
  });

  it("keeps transient poll failures recoverable but stops on permanent ones", () => {
    const transient = transitionExecutionUiRunState(stateWithJob(), {
      type: "poll-failed",
      message: "Network hiccup.",
      stopPolling: false,
    });
    expect(transient.state.backgroundError).toBe("Network hiccup.");
    expect(transient.effects).toEqual([]);

    const permanent = transitionExecutionUiRunState(transient.state, {
      type: "poll-failed",
      message: "Job not found.",
      stopPolling: true,
    });
    expect(permanent.state.backgroundError).toBe("Job not found.");
    expect(permanent.effects).toEqual([{ type: "stop-polling" }]);
  });
});

describe("transitionExecutionUiRunState cancellation and download", () => {
  it("requests cancellation and polls immediately after the resolver responds", () => {
    const requested = transitionExecutionUiRunState(stateWithJob(), {
      type: "cancel-requested",
    });

    expect(requested.state.cancelling).toBe(true);
    expect(requested.effects).toEqual([
      { type: "cancel-export", jobId: "job-1" },
    ]);

    const cancelled = transitionExecutionUiRunState(requested.state, {
      type: "cancel-succeeded",
      job: makeJob({ cancelRequested: true }),
    });

    expect(cancelled.state).toMatchObject({
      cancelling: false,
      backgroundError: null,
      job: { cancelRequested: true },
    });
    expect(cancelled.effects).toEqual([{ type: "poll-job", jobId: "job-1" }]);
  });

  it("stores a download URL only for the current job", () => {
    const state = stateWithJob(makeJob({ jobId: "job-current" }));

    const stale = transitionExecutionUiRunState(state, {
      type: "download-succeeded",
      jobId: "job-old",
      url: "https://download.example.com/old",
    });
    expect(stale.state.downloadUrl).toBeNull();

    const current = transitionExecutionUiRunState(stale.state, {
      type: "download-succeeded",
      jobId: "job-current",
      url: "https://download.example.com/current",
    });
    expect(current.state.downloadUrl).toBe(
      "https://download.example.com/current",
    );
  });
});

describe("transitionExecutionUiRunState reset and view selection", () => {
  it("clears local run state and asks the edge to clear the active job pointer", () => {
    const transition = transitionExecutionUiRunState(
      stateWithJob(makeJob({ status: "ready" }), {
        downloadUrl: "https://download.example.com/current",
        backgroundError: "Old warning.",
      }),
      { type: "reset-requested" },
    );

    expect(transition.state).toEqual(createInitialExecutionUiRunState());
    expect(transition.effects).toEqual([
      { type: "stop-polling" },
      { type: "clear-active-export" },
    ]);
  });

  it("derives the render-facing view from canonical run state", () => {
    const view = selectExecutionUiRunView(
      stateWithJob(
        makeJob({
          status: "cancelled",
          skipped: [{ id: "2", title: null, reason: "403 Forbidden" }],
        }),
      ),
    );

    expect(view).toMatchObject({
      isRunning: false,
      isTerminal: true,
      skipped: [{ id: "2", title: null, reason: "403 Forbidden" }],
    });
  });
});

describe("run state edge helpers", () => {
  it("recognizes resolver error results and normalizes thrown messages", () => {
    expect(isErrorResult({ error: "boom" })).toBe(true);
    expect(isErrorResult({ jobId: "job-1" })).toBe(false);
    expect(messageFor(new Error("boom"), "fallback")).toBe("boom");
    expect(messageFor("boom", "fallback")).toBe("fallback");
  });
});
