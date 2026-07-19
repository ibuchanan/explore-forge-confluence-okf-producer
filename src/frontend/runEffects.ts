import {
  isErrorResult,
  messageFor,
  type ErrorResult,
  type ExecutionUiRunEffect,
  type ExecutionUiRunEvent,
  type ExportJobView,
  type StartExportInput,
} from "./runState";

type MaybeResult<T> = T | ErrorResult | null | undefined;

export interface ExecutionUiRunEffectAdapters {
  resumeActiveExport: () => Promise<MaybeResult<{ job: ExportJobView | null }>>;
  startExport: (
    input: StartExportInput,
  ) => Promise<MaybeResult<{ jobId: string }>>;
  pollJob: (jobId: string) => Promise<MaybeResult<ExportJobView>>;
  cancelExport: (jobId: string) => Promise<MaybeResult<ExportJobView>>;
  createDownloadUrl: (jobId: string) => Promise<MaybeResult<{ url: string }>>;
  startPolling: (jobId: string) => void;
  stopPolling: () => void;
  clearActiveExport: () => Promise<unknown>;
  onResumeError: (exc: unknown) => void;
  onClearActiveExportError: (exc: unknown) => void;
}

export type DispatchExecutionUiRunEvent = (event: ExecutionUiRunEvent) => void;

type EffectOf<Type extends ExecutionUiRunEffect["type"]> = Extract<
  ExecutionUiRunEffect,
  { type: Type }
>;

type EffectRunners = {
  [Type in ExecutionUiRunEffect["type"]]: (
    effect: EffectOf<Type>,
    adapters: ExecutionUiRunEffectAdapters,
    dispatch: DispatchExecutionUiRunEvent,
  ) => void;
};

function runResumeEffect(
  adapters: ExecutionUiRunEffectAdapters,
  dispatch: DispatchExecutionUiRunEvent,
): void {
  adapters
    .resumeActiveExport()
    .then((result) => {
      if (!result || isErrorResult(result)) {
        return;
      }
      dispatch({ type: "resume-succeeded", job: result.job });
    })
    .catch(adapters.onResumeError);
}

function runStartEffect(
  input: StartExportInput,
  adapters: ExecutionUiRunEffectAdapters,
  dispatch: DispatchExecutionUiRunEvent,
): void {
  adapters
    .startExport(input)
    .then((result) => {
      if (!result || isErrorResult(result)) {
        dispatch({
          type: "start-failed",
          message: isErrorResult(result)
            ? result.error
            : "Could not start the export.",
        });
        return;
      }
      dispatch({
        type: "start-succeeded",
        jobId: result.jobId,
        bundleSlug: input.bundleSlug,
      });
    })
    .catch((exc) => {
      dispatch({
        type: "start-failed",
        message: messageFor(exc, "Could not start the export."),
      });
    });
}

function runPollEffect(
  jobId: string,
  adapters: ExecutionUiRunEffectAdapters,
  dispatch: DispatchExecutionUiRunEvent,
): void {
  adapters
    .pollJob(jobId)
    .then((result) => {
      if (!result || isErrorResult(result)) {
        dispatch({
          type: "poll-failed",
          message: isErrorResult(result)
            ? result.error
            : "Could not check the export status.",
          stopPolling: true,
        });
        return;
      }
      dispatch({ type: "poll-succeeded", job: result });
    })
    .catch((exc) => {
      dispatch({
        type: "poll-failed",
        message: messageFor(exc, "Could not check the export status."),
        stopPolling: false,
      });
    });
}

function runCancelEffect(
  jobId: string,
  adapters: ExecutionUiRunEffectAdapters,
  dispatch: DispatchExecutionUiRunEvent,
): void {
  adapters
    .cancelExport(jobId)
    .then((result) => {
      if (!result || isErrorResult(result)) {
        dispatch({
          type: "cancel-failed",
          jobId,
          message: isErrorResult(result)
            ? result.error
            : "Could not cancel the export.",
        });
        return;
      }
      dispatch({ type: "cancel-succeeded", job: result });
    })
    .catch((exc) => {
      dispatch({
        type: "cancel-failed",
        jobId,
        message: messageFor(exc, "Could not cancel the export."),
      });
    });
}

function runDownloadEffect(
  jobId: string,
  adapters: ExecutionUiRunEffectAdapters,
  dispatch: DispatchExecutionUiRunEvent,
): void {
  adapters
    .createDownloadUrl(jobId)
    .then((result) => {
      if (!result || isErrorResult(result)) {
        dispatch({
          type: "download-failed",
          jobId,
          message: isErrorResult(result)
            ? result.error
            : "Could not create a download link.",
        });
        return;
      }
      dispatch({ type: "download-succeeded", jobId, url: result.url });
    })
    .catch((exc) => {
      dispatch({
        type: "download-failed",
        jobId,
        message: messageFor(exc, "Could not create a download link."),
      });
    });
}

const effectRunners = {
  "resume-active-export": (_effect, adapters, dispatch) => {
    runResumeEffect(adapters, dispatch);
  },
  "start-export": (effect, adapters, dispatch) => {
    runStartEffect(effect.input, adapters, dispatch);
  },
  "poll-job": (effect, adapters, dispatch) => {
    runPollEffect(effect.jobId, adapters, dispatch);
  },
  "start-polling": (effect, adapters) => {
    adapters.startPolling(effect.jobId);
  },
  "stop-polling": (_effect, adapters) => {
    adapters.stopPolling();
  },
  "cancel-export": (effect, adapters, dispatch) => {
    runCancelEffect(effect.jobId, adapters, dispatch);
  },
  "create-download-url": (effect, adapters, dispatch) => {
    runDownloadEffect(effect.jobId, adapters, dispatch);
  },
  "clear-active-export": (_effect, adapters) => {
    adapters.clearActiveExport().catch(adapters.onClearActiveExportError);
  },
} satisfies EffectRunners;

export function executeExecutionUiRunEffect(
  effect: ExecutionUiRunEffect,
  adapters: ExecutionUiRunEffectAdapters,
  dispatch: DispatchExecutionUiRunEvent,
): void {
  const runner = effectRunners[effect.type] as (
    currentEffect: ExecutionUiRunEffect,
    currentAdapters: ExecutionUiRunEffectAdapters,
    currentDispatch: DispatchExecutionUiRunEvent,
  ) => void;
  runner(effect, adapters, dispatch);
}
