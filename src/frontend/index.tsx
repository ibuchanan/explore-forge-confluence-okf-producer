import { invoke } from "@forge/bridge";
import ForgeReconciler, {
  Button,
  Heading,
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
}

interface ErrorResult {
  error: string;
}

function isErrorResult(value: unknown): value is ErrorResult {
  return (
    Boolean(value) && typeof value === "object" && "error" in (value as object)
  );
}

const App = () => {
  const [rootUrl, setRootUrl] = useState("");
  const [depth, setDepth] = useState(5);
  const [bundleSlug, setBundleSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [loadingDefault, setLoadingDefault] = useState(true);
  const [starting, setStarting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [job, setJob] = useState<ExportJobView | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

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
      .finally(() => setLoadingDefault(false));
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const pollJob = useCallback(
    (jobId: string) => {
      invoke<ExportJobView | ErrorResult>("getExportJob", { jobId }).then(
        (raw) => {
          const result = raw as ExportJobView | ErrorResult;
          if (!result || isErrorResult(result)) {
            stopPolling();
            return;
          }
          setJob(result);
          if (TERMINAL_STATUSES.has(result.status)) {
            stopPolling();
          }
        },
      );
    },
    [stopPolling],
  );

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
      setJob({
        jobId: result.jobId,
        status: "queued",
        stage: "validating",
        bundleSlug,
        exportedCount: 0,
        skipped: [],
      });
      stopPolling();
      pollRef.current = setInterval(
        () => pollJob(result.jobId),
        POLL_INTERVAL_MS,
      );
    } finally {
      setStarting(false);
    }
  }, [rootUrl, depth, bundleSlug, pollJob, stopPolling]);

  const handleCancel = useCallback(() => {
    if (job?.jobId) {
      invoke("cancelExportJob", { jobId: job.jobId });
    }
  }, [job]);

  const handleReset = useCallback(() => {
    stopPolling();
    setJob(null);
    setDownloadUrl(null);
    setFormError(null);
  }, [stopPolling]);

  useEffect(() => {
    if (job?.status === "ready" && job.jobId && !downloadUrl) {
      invoke<{ url: string } | ErrorResult>("createArchiveDownloadUrl", {
        jobId: job.jobId,
      }).then((raw) => {
        const result = raw as { url: string } | ErrorResult;
        if (result && !isErrorResult(result)) {
          setDownloadUrl(result.url);
        }
      });
    }
  }, [job, downloadUrl]);

  const isRunning = job && !TERMINAL_STATUSES.has(job.status);
  const skipped = job?.skipped ?? [];

  return (
    <Stack space="space.200">
      <Heading size="medium">OKF Producer</Heading>
      <Text>
        Export a Confluence page tree into a downloadable OKF bundle for local
        agent tooling.
      </Text>

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
              <Button appearance="subtle" onClick={handleCancel}>
                Cancel
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
