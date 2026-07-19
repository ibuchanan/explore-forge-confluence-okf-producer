import { invoke } from "@forge/bridge";
import ForgeReconciler, { SectionMessage, Stack, Text } from "@forge/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { deriveSlugFromUrl } from "../util/pageUrl";
import {
  executeExecutionUiRunEffect,
  type ExecutionUiRunEffectAdapters,
} from "./runEffects";
import {
  createInitialExecutionUiRunState,
  selectExecutionUiRunView,
  transitionExecutionUiRunState,
  type ErrorResult,
  type ExecutionUiRunEffect,
  type ExecutionUiRunEvent,
  type ExportJobView,
} from "./runState";
import {
  ExportRunPanel,
  ExportStartForm,
  type TextfieldChangeEvent,
} from "./views";

const POLL_INTERVAL_MS = 2500;

function createRunEffectAdapters(
  startPolling: (jobId: string) => void,
  stopPolling: () => void,
): ExecutionUiRunEffectAdapters {
  return {
    resumeActiveExport: async () =>
      (await invoke<{ job: ExportJobView | null } | ErrorResult>(
        "getActiveExportJob",
      )) as { job: ExportJobView | null } | ErrorResult,
    startExport: async (input) =>
      (await invoke<{ jobId: string } | ErrorResult>(
        "startExportJob",
        input,
      )) as { jobId: string } | ErrorResult,
    pollJob: async (jobId) =>
      (await invoke<ExportJobView | ErrorResult>("getExportJob", {
        jobId,
      })) as ExportJobView | ErrorResult,
    cancelExport: async (jobId) =>
      (await invoke<ExportJobView | ErrorResult>("cancelExportJob", {
        jobId,
      })) as ExportJobView | ErrorResult,
    createDownloadUrl: async (jobId) =>
      (await invoke<{ url: string } | ErrorResult>("createArchiveDownloadUrl", {
        jobId,
      })) as { url: string } | ErrorResult,
    startPolling,
    stopPolling,
    clearActiveExport: async () => await invoke("clearActiveExportJob"),
    onResumeError: (exc) => {
      console.error("Could not resume an active export:", exc);
    },
    onClearActiveExportError: (exc) => {
      console.error("Could not clear the active export job:", exc);
    },
  };
}

const App = () => {
  const [rootUrl, setRootUrl] = useState("");
  const [depth, setDepth] = useState(5);
  const [bundleSlug, setBundleSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [loadingDefault, setLoadingDefault] = useState(true);
  const [runState, setRunState] = useState(createInitialExecutionUiRunState);
  const runStateRef = useRef(runState);
  const dispatchRunRef = useRef<(event: ExecutionUiRunEvent) => void>(() => {});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      pollRef.current = setInterval(() => {
        dispatchRunRef.current({ type: "poll-requested", jobId });
      }, POLL_INTERVAL_MS);
    },
    [stopPolling],
  );

  const executeRunEffect = useCallback(
    (effect: ExecutionUiRunEffect) => {
      executeExecutionUiRunEffect(
        effect,
        createRunEffectAdapters(startPolling, stopPolling),
        (event) => dispatchRunRef.current(event),
      );
    },
    [startPolling, stopPolling],
  );

  const dispatchRun = useCallback(
    (event: ExecutionUiRunEvent) => {
      const transition = transitionExecutionUiRunState(
        runStateRef.current,
        event,
      );
      runStateRef.current = transition.state;
      setRunState(transition.state);
      for (const effect of transition.effects) {
        executeRunEffect(effect);
      }
    },
    [executeRunEffect],
  );
  dispatchRunRef.current = dispatchRun;

  useEffect(() => {
    invoke<{ rootUrl: string | null }>("getDefaultSource")
      .then((raw) => {
        // invoke()'s declared return type is `T | { body: T; metadata? }` to
        // support an opt-in metadata mode we never request; at runtime,
        // without that option, it always resolves to plain T.
        const result = raw as { rootUrl: string | null };
        if (result?.rootUrl) {
          setRootUrl(result.rootUrl);
          setBundleSlug(deriveSlugFromUrl(result.rootUrl));
        }
      })
      .catch((exc) => {
        console.error("Could not load the default source:", exc);
      })
      .finally(() => setLoadingDefault(false));
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // Resume an in-flight or recently-finished job after a navigation or
  // remount, instead of always starting from a blank form.
  useEffect(() => {
    dispatchRun({ type: "resume-requested" });
  }, [dispatchRun]);

  const handleRootUrlChange = useCallback(
    (event: TextfieldChangeEvent) => {
      const value = String(event.target.value ?? "");
      setRootUrl(value);
      if (!slugTouched) {
        setBundleSlug(deriveSlugFromUrl(value));
      }
    },
    [slugTouched],
  );

  const handleBundleSlugChange = useCallback((event: TextfieldChangeEvent) => {
    setSlugTouched(true);
    setBundleSlug(String(event.target.value ?? ""));
  }, []);

  const handleStart = useCallback(() => {
    dispatchRun({
      type: "start-requested",
      input: { rootUrl, depth, bundleSlug },
    });
  }, [rootUrl, depth, bundleSlug, dispatchRun]);

  const handleCancel = useCallback(() => {
    dispatchRun({ type: "cancel-requested" });
  }, [dispatchRun]);

  const handleReset = useCallback(() => {
    dispatchRun({ type: "reset-requested" });
  }, [dispatchRun]);

  const {
    job,
    starting,
    cancelling,
    startError,
    backgroundError,
    downloadUrl,
    skipped,
    isRunning,
    isTerminal,
  } = selectExecutionUiRunView(runState);

  return (
    <Stack space="space.200">
      <Text>
        Export a Confluence page tree into a downloadable OKF bundle for local
        agent tooling.
      </Text>

      {backgroundError && (
        <SectionMessage appearance="warning">
          <Text>{backgroundError}</Text>
        </SectionMessage>
      )}

      {!job && (
        <ExportStartForm
          values={{ rootUrl, depth, bundleSlug }}
          state={{ loadingDefault, starting, startError }}
          handlers={{
            onRootUrlChange: handleRootUrlChange,
            onDepthChange: setDepth,
            onBundleSlugChange: handleBundleSlugChange,
            onStart: handleStart,
          }}
        />
      )}

      {job && (
        <ExportRunPanel
          view={{
            job,
            skipped,
            isRunning,
            isTerminal,
            cancelling,
            downloadUrl,
          }}
          onCancel={handleCancel}
          onReset={handleReset}
        />
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
