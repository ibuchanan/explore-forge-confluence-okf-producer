import { invoke } from "@forge/bridge";
import ForgeReconciler, {
  Button,
  Inline,
  Label,
  Link,
  List,
  ListItem,
  Lozenge,
  Range,
  SectionMessage,
  Stack,
  Text,
  Textfield,
} from "@forge/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { deriveSlugFromUrl } from "../util/pageUrl";
import { lozengeAppearanceFor, stageLabel } from "./formatting";

const POLL_INTERVAL_MS = 2500;
const TERMINAL_STATUSES = new Set(["ready", "failed", "cancelled"]);

interface SkippedPageView {
  id: string;
  title: string | null;
  reason: string;
}

interface ExportJobView {
  jobId: string;
  status: string;
  stage: string;
  bundleSlug: string;
  exportedCount: number;
  skipped: SkippedPageView[];
  errorMessage?: string | null;
  cancelRequested?: boolean;
}

interface ErrorResult {
  error: string;
}

function isErrorResult(value: unknown): value is ErrorResult {
  return (
    Boolean(value) && typeof value === "object" && "error" in (value as object)
  );
}

function messageFor(exc: unknown, fallback: string): string {
  return exc instanceof Error ? exc.message : fallback;
}

const App = () => {
  const [rootUrl, setRootUrl] = useState("");
  const [depth, setDepth] = useState(5);
  const [bundleSlug, setBundleSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [loadingDefault, setLoadingDefault] = useState(true);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Errors from background work (polling, cancelling, resuming a job) --
  // distinct from formError, which only applies to the pre-job form, and
  // from job.errorMessage, which is the backend's own export-failure reason.
  const [pollError, setPollError] = useState<string | null>(null);
  const [job, setJob] = useState<ExportJobView | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (jobId: string, poll: (jobId: string) => void) => {
      stopPolling();
      pollRef.current = setInterval(() => poll(jobId), POLL_INTERVAL_MS);
    },
    [stopPolling],
  );

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

  const pollJob = useCallback(
    (jobId: string) => {
      invoke<ExportJobView | ErrorResult>("getExportJob", { jobId })
        .then((raw) => {
          const result = raw as ExportJobView | ErrorResult;
          if (!result || isErrorResult(result)) {
            setPollError(
              isErrorResult(result)
                ? result.error
                : "Could not check the export status.",
            );
            stopPolling();
            return;
          }
          setPollError(null);
          setJob(result);
          if (TERMINAL_STATUSES.has(result.status)) {
            stopPolling();
          }
        })
        .catch((exc) => {
          // Leave polling running -- this may be a transient hiccup, and the
          // next tick can recover. A permanent problem (e.g. the job record
          // is gone) comes back as an {error} result above and does stop it.
          setPollError(messageFor(exc, "Could not check the export status."));
        });
    },
    [stopPolling],
  );

  // Resume an in-flight or recently-finished job after a navigation or
  // remount, instead of always starting from a blank form.
  useEffect(() => {
    invoke<{ job: ExportJobView | null } | ErrorResult>("getActiveExportJob")
      .then((raw) => {
        const result = raw as { job: ExportJobView | null } | ErrorResult;
        if (!result || isErrorResult(result) || !result.job) {
          return;
        }
        setJob(result.job);
        if (!TERMINAL_STATUSES.has(result.job.status)) {
          startPolling(result.job.jobId, pollJob);
        }
      })
      .catch((exc) => {
        console.error("Could not resume an active export:", exc);
      });
  }, [pollJob, startPolling]);

  const handleRootUrlChange = useCallback(
    (event: { target: { value?: unknown } }) => {
      const value = String(event.target.value ?? "");
      setRootUrl(value);
      if (!slugTouched) {
        setBundleSlug(deriveSlugFromUrl(value));
      }
    },
    [slugTouched],
  );

  const handleBundleSlugChange = useCallback(
    (event: { target: { value?: unknown } }) => {
      setSlugTouched(true);
      setBundleSlug(String(event.target.value ?? ""));
    },
    [],
  );

  const handleStart = useCallback(async () => {
    setFormError(null);
    setStarting(true);
    setDownloadUrl(null);
    try {
      const raw = await invoke<{ jobId: string } | ErrorResult>(
        "startExportJob",
        {
          rootUrl,
          depth,
          bundleSlug,
        },
      );
      const result = raw as { jobId: string } | ErrorResult;
      if (!result || isErrorResult(result)) {
        setFormError(
          isErrorResult(result) ? result.error : "Could not start the export.",
        );
        return;
      }
      setPollError(null);
      setJob({
        jobId: result.jobId,
        status: "queued",
        stage: "fetching-pages",
        bundleSlug,
        exportedCount: 0,
        skipped: [],
      });
      startPolling(result.jobId, pollJob);
    } catch (exc) {
      setFormError(messageFor(exc, "Could not start the export."));
    } finally {
      setStarting(false);
    }
  }, [rootUrl, depth, bundleSlug, pollJob, startPolling]);

  const handleCancel = useCallback(async () => {
    if (!job?.jobId) {
      return;
    }
    setCancelling(true);
    setPollError(null);
    try {
      const raw = await invoke<ExportJobView | ErrorResult>("cancelExportJob", {
        jobId: job.jobId,
      });
      const result = raw as ExportJobView | ErrorResult;
      if (!result || isErrorResult(result)) {
        setPollError(
          isErrorResult(result) ? result.error : "Could not cancel the export.",
        );
      }
    } catch (exc) {
      setPollError(messageFor(exc, "Could not cancel the export."));
    } finally {
      setCancelling(false);
      // Refresh right away instead of waiting for the next poll tick, so
      // clicking Cancel has a visible effect as soon as possible.
      pollJob(job.jobId);
    }
  }, [job, pollJob]);

  const handleReset = useCallback(() => {
    stopPolling();
    setJob(null);
    setDownloadUrl(null);
    setFormError(null);
    setPollError(null);
    // Best-effort: so a reload after dismissing a finished job doesn't
    // resurrect it via getActiveExportJob. Not critical if this fails --
    // worst case the dismissed job just reappears on the next reload.
    invoke("clearActiveExportJob").catch((exc) => {
      console.error("Could not clear the active export job:", exc);
    });
  }, [stopPolling]);

  useEffect(() => {
    if (job?.status === "ready" && job.jobId && !downloadUrl) {
      invoke<{ url: string } | ErrorResult>("createArchiveDownloadUrl", {
        jobId: job.jobId,
      })
        .then((raw) => {
          const result = raw as { url: string } | ErrorResult;
          if (!result || isErrorResult(result)) {
            setPollError(
              isErrorResult(result)
                ? result.error
                : "Could not create a download link.",
            );
            return;
          }
          setDownloadUrl(result.url);
        })
        .catch((exc) => {
          setPollError(messageFor(exc, "Could not create a download link."));
        });
    }
  }, [job, downloadUrl]);

  const isRunning = job && !TERMINAL_STATUSES.has(job.status);
  const skipped = job?.skipped ?? [];

  return (
    <Stack space="space.200">
      <Text>
        Export a Confluence page tree into a downloadable OKF bundle for local
        agent tooling.
      </Text>

      {pollError && (
        <SectionMessage appearance="warning">
          <Text>{pollError}</Text>
        </SectionMessage>
      )}

      {!job && (
        <Stack space="space.150">
          <Stack space="space.050">
            <Label labelFor="root-url">Root page URL</Label>
            <Textfield
              id="root-url"
              value={rootUrl}
              onChange={handleRootUrlChange}
              placeholder={
                loadingDefault
                  ? "Loading default…"
                  : "https://your-site.atlassian.net/wiki/spaces/KEY/pages/123456/Title"
              }
              isDisabled={starting}
            />
          </Stack>

          <Stack space="space.050">
            <Label labelFor="depth">Depth cap: {depth}</Label>
            <Range
              id="depth"
              min={1}
              max={5}
              step={1}
              value={depth}
              onChange={setDepth}
              isDisabled={starting}
            />
          </Stack>

          <Stack space="space.050">
            <Label labelFor="bundle-slug">Bundle slug</Label>
            <Textfield
              id="bundle-slug"
              value={bundleSlug}
              onChange={handleBundleSlugChange}
              isDisabled={starting}
            />
          </Stack>

          {formError && (
            <SectionMessage appearance="error">
              <Text>{formError}</Text>
            </SectionMessage>
          )}

          <Inline>
            <Button
              appearance="primary"
              onClick={handleStart}
              isDisabled={starting || !rootUrl}
            >
              {starting ? "Starting…" : "Start export"}
            </Button>
          </Inline>
        </Stack>
      )}

      {job && (
        <Stack space="space.150">
          <Inline space="space.100">
            <Lozenge appearance={lozengeAppearanceFor(job.status)}>
              {stageLabel(job.stage)}
            </Lozenge>
            <Text>
              Exported {job.exportedCount || 0} pages
              {skipped.length > 0 ? `, ${skipped.length} skipped` : ""}.
            </Text>
          </Inline>

          {isRunning && (
            <Inline>
              <Button
                appearance="subtle"
                onClick={handleCancel}
                isDisabled={cancelling || job.cancelRequested}
              >
                {cancelling
                  ? "Cancelling…"
                  : job.cancelRequested
                    ? "Cancel requested…"
                    : "Cancel"}
              </Button>
            </Inline>
          )}

          {job.status === "failed" && (
            <SectionMessage appearance="error" title="Export failed">
              <Text>{job.errorMessage}</Text>
            </SectionMessage>
          )}

          {job.status === "cancelled" && (
            <SectionMessage appearance="warning" title="Export cancelled">
              <Text>The export was cancelled.</Text>
            </SectionMessage>
          )}

          {job.status === "ready" && (
            <SectionMessage appearance="success" title="Bundle ready">
              {downloadUrl ? (
                <Link href={downloadUrl} openNewTab>
                  Download {job.bundleSlug}.zip
                </Link>
              ) : (
                <Text>Preparing download link…</Text>
              )}
            </SectionMessage>
          )}

          {skipped.length > 0 && (
            <Stack space="space.050">
              <Text>Skipped pages:</Text>
              <List type="unordered">
                {skipped.map((entry) => (
                  <ListItem key={entry.id}>
                    {entry.title || entry.id}: {entry.reason}
                  </ListItem>
                ))}
              </List>
            </Stack>
          )}

          {TERMINAL_STATUSES.has(job.status) && (
            <Inline>
              <Button onClick={handleReset}>Start a new export</Button>
            </Inline>
          )}
        </Stack>
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
