const TERMINAL_STATUSES = new Set(["ready", "failed", "cancelled"]);

export interface SkippedPageView {
  id: string;
  title: string | null;
  reason: string;
}

export interface ExportJobView {
  jobId: string;
  status: string;
  stage: string;
  bundleSlug: string;
  exportedCount: number;
  skipped: SkippedPageView[];
  errorMessage?: string | null;
  cancelRequested?: boolean;
}

export interface ErrorResult {
  error: string;
}

export interface StartExportInput {
  rootUrl: string;
  depth: number;
  bundleSlug: string;
}

export interface ExecutionUiRunState {
  job: ExportJobView | null;
  starting: boolean;
  cancelling: boolean;
  startError: string | null;
  backgroundError: string | null;
  downloadUrl: string | null;
  downloadRequestedForJobId: string | null;
}

export type ExecutionUiRunEffect =
  | { type: "resume-active-export" }
  | { type: "start-export"; input: StartExportInput }
  | { type: "poll-job"; jobId: string }
  | { type: "start-polling"; jobId: string }
  | { type: "stop-polling" }
  | { type: "cancel-export"; jobId: string }
  | { type: "create-download-url"; jobId: string }
  | { type: "clear-active-export" };

export type ExecutionUiRunEvent =
  | { type: "resume-requested" }
  | { type: "resume-succeeded"; job: ExportJobView | null }
  | { type: "start-requested"; input: StartExportInput }
  | { type: "start-succeeded"; jobId: string; bundleSlug: string }
  | { type: "start-failed"; message: string }
  | { type: "poll-requested"; jobId: string }
  | { type: "poll-succeeded"; job: ExportJobView }
  | { type: "poll-failed"; message: string; stopPolling: boolean }
  | { type: "cancel-requested" }
  | { type: "cancel-succeeded"; job: ExportJobView }
  | { type: "cancel-failed"; jobId: string; message: string }
  | { type: "download-succeeded"; jobId: string; url: string }
  | { type: "download-failed"; jobId: string; message: string }
  | { type: "reset-requested" };

export interface ExecutionUiRunTransition {
  state: ExecutionUiRunState;
  effects: ExecutionUiRunEffect[];
}

export interface ExecutionUiRunView {
  job: ExportJobView | null;
  starting: boolean;
  cancelling: boolean;
  startError: string | null;
  backgroundError: string | null;
  downloadUrl: string | null;
  skipped: SkippedPageView[];
  isRunning: boolean;
  isTerminal: boolean;
}

export function createInitialExecutionUiRunState(): ExecutionUiRunState {
  return {
    job: null,
    starting: false,
    cancelling: false,
    startError: null,
    backgroundError: null,
    downloadUrl: null,
    downloadRequestedForJobId: null,
  };
}

export function isErrorResult(value: unknown): value is ErrorResult {
  return (
    Boolean(value) && typeof value === "object" && "error" in (value as object)
  );
}

export function messageFor(exc: unknown, fallback: string): string {
  return exc instanceof Error ? exc.message : fallback;
}

function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function withoutEffects(state: ExecutionUiRunState): ExecutionUiRunTransition {
  return { state, effects: [] };
}

function withJob(
  state: ExecutionUiRunState,
  job: ExportJobView,
): ExecutionUiRunState {
  const sameJob = state.job?.jobId === job.jobId;
  return {
    ...state,
    job,
    downloadUrl: sameJob ? state.downloadUrl : null,
    downloadRequestedForJobId: sameJob ? state.downloadRequestedForJobId : null,
  };
}

function withJobEffects(state: ExecutionUiRunState): ExecutionUiRunTransition {
  const effects: ExecutionUiRunEffect[] = [];
  if (!state.job) {
    return { state, effects };
  }
  if (isTerminalJobStatus(state.job.status)) {
    effects.push({ type: "stop-polling" });
  }
  if (
    state.job.status === "ready" &&
    !state.downloadUrl &&
    state.downloadRequestedForJobId !== state.job.jobId
  ) {
    return {
      state: { ...state, downloadRequestedForJobId: state.job.jobId },
      effects: [
        ...effects,
        { type: "create-download-url", jobId: state.job.jobId },
      ],
    };
  }
  return { state, effects };
}

function optimisticQueuedJob(jobId: string, bundleSlug: string): ExportJobView {
  return {
    jobId,
    status: "queued",
    stage: "fetching-pages",
    bundleSlug,
    exportedCount: 0,
    skipped: [],
  };
}

type EventOf<Type extends ExecutionUiRunEvent["type"]> = Extract<
  ExecutionUiRunEvent,
  { type: Type }
>;

type RunEventHandlers = {
  [Type in ExecutionUiRunEvent["type"]]: (
    state: ExecutionUiRunState,
    event: EventOf<Type>,
  ) => ExecutionUiRunTransition;
};

function transitionResumeSucceeded(
  state: ExecutionUiRunState,
  event: EventOf<"resume-succeeded">,
): ExecutionUiRunTransition {
  if (!event.job) {
    return withoutEffects(state);
  }
  const jobTransition = withJobEffects(
    withJob({ ...state, backgroundError: null }, event.job),
  );
  return {
    state: jobTransition.state,
    effects: isTerminalJobStatus(event.job.status)
      ? jobTransition.effects
      : [
          ...jobTransition.effects,
          { type: "start-polling", jobId: event.job.jobId },
        ],
  };
}

function transitionStartRequested(
  state: ExecutionUiRunState,
  event: EventOf<"start-requested">,
): ExecutionUiRunTransition {
  return {
    state: {
      ...state,
      starting: true,
      startError: null,
      backgroundError: null,
      downloadUrl: null,
      downloadRequestedForJobId: null,
    },
    effects: [{ type: "start-export", input: event.input }],
  };
}

function transitionStartSucceeded(
  state: ExecutionUiRunState,
  event: EventOf<"start-succeeded">,
): ExecutionUiRunTransition {
  return {
    state: {
      ...state,
      job: optimisticQueuedJob(event.jobId, event.bundleSlug),
      starting: false,
      startError: null,
      backgroundError: null,
      downloadUrl: null,
      downloadRequestedForJobId: null,
    },
    effects: [{ type: "start-polling", jobId: event.jobId }],
  };
}

function transitionPollSucceeded(
  state: ExecutionUiRunState,
  event: EventOf<"poll-succeeded">,
): ExecutionUiRunTransition {
  return withJobEffects(
    withJob(
      {
        ...state,
        backgroundError: null,
      },
      event.job,
    ),
  );
}

function transitionCancelRequested(
  state: ExecutionUiRunState,
): ExecutionUiRunTransition {
  return state.job
    ? {
        state: {
          ...state,
          cancelling: true,
          backgroundError: null,
        },
        effects: [{ type: "cancel-export", jobId: state.job.jobId }],
      }
    : withoutEffects(state);
}

function transitionCancelSucceeded(
  state: ExecutionUiRunState,
  event: EventOf<"cancel-succeeded">,
): ExecutionUiRunTransition {
  const jobTransition = withJobEffects(
    withJob(
      {
        ...state,
        cancelling: false,
        backgroundError: null,
      },
      event.job,
    ),
  );
  return {
    state: jobTransition.state,
    effects: isTerminalJobStatus(event.job.status)
      ? jobTransition.effects
      : [
          ...jobTransition.effects,
          { type: "poll-job", jobId: event.job.jobId },
        ],
  };
}

const runEventHandlers = {
  "resume-requested": (state) => ({
    state,
    effects: [{ type: "resume-active-export" }],
  }),
  "resume-succeeded": transitionResumeSucceeded,
  "start-requested": transitionStartRequested,
  "start-succeeded": transitionStartSucceeded,
  "start-failed": (state, event) =>
    withoutEffects({
      ...state,
      starting: false,
      startError: event.message,
    }),
  "poll-requested": (state, event) => ({
    state,
    effects: [{ type: "poll-job", jobId: event.jobId }],
  }),
  "poll-succeeded": transitionPollSucceeded,
  "poll-failed": (state, event) => ({
    state: {
      ...state,
      backgroundError: event.message,
    },
    effects: event.stopPolling ? [{ type: "stop-polling" }] : [],
  }),
  "cancel-requested": (state) => transitionCancelRequested(state),
  "cancel-succeeded": transitionCancelSucceeded,
  "cancel-failed": (state, event) => ({
    state: {
      ...state,
      cancelling: false,
      backgroundError: event.message,
    },
    effects: [{ type: "poll-job", jobId: event.jobId }],
  }),
  "download-succeeded": (state, event) =>
    state.job?.jobId === event.jobId
      ? withoutEffects({
          ...state,
          backgroundError: null,
          downloadUrl: event.url,
        })
      : withoutEffects(state),
  "download-failed": (state, event) =>
    state.job?.jobId === event.jobId
      ? withoutEffects({ ...state, backgroundError: event.message })
      : withoutEffects(state),
  "reset-requested": () => ({
    state: createInitialExecutionUiRunState(),
    effects: [{ type: "stop-polling" }, { type: "clear-active-export" }],
  }),
} satisfies RunEventHandlers;

export function transitionExecutionUiRunState(
  state: ExecutionUiRunState,
  event: ExecutionUiRunEvent,
): ExecutionUiRunTransition {
  const handler = runEventHandlers[event.type] as (
    currentState: ExecutionUiRunState,
    currentEvent: ExecutionUiRunEvent,
  ) => ExecutionUiRunTransition;
  return handler(state, event);
}

export function selectExecutionUiRunView(
  state: ExecutionUiRunState,
): ExecutionUiRunView {
  const isTerminal = Boolean(
    state.job && isTerminalJobStatus(state.job.status),
  );
  return {
    job: state.job,
    starting: state.starting,
    cancelling: state.cancelling,
    startError: state.startError,
    backgroundError: state.backgroundError,
    downloadUrl: state.downloadUrl,
    skipped: state.job?.skipped ?? [],
    isRunning: Boolean(state.job && !isTerminal),
    isTerminal,
  };
}
