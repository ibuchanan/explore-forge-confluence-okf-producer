import {
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
import { lozengeAppearanceFor, stageLabel } from "./formatting";
import type { ExportJobView, SkippedPageView } from "./runState";

export interface TextfieldChangeEvent {
  target: { value?: unknown };
}

interface ExportStartFormValues {
  rootUrl: string;
  depth: number;
  bundleSlug: string;
}

interface ExportStartFormState {
  loadingDefault: boolean;
  starting: boolean;
  startError: string | null;
}

interface ExportStartFormHandlers {
  onRootUrlChange: (event: TextfieldChangeEvent) => void;
  onDepthChange: (value: number) => void;
  onBundleSlugChange: (event: TextfieldChangeEvent) => void;
  onStart: () => void;
}

interface ExportStartFormProps {
  values: ExportStartFormValues;
  state: ExportStartFormState;
  handlers: ExportStartFormHandlers;
}

function RootUrlField({
  value,
  loadingDefault,
  disabled,
  onChange,
}: {
  value: string;
  loadingDefault: boolean;
  disabled: boolean;
  onChange: (event: TextfieldChangeEvent) => void;
}) {
  return (
    <Stack space="space.050">
      <Label labelFor="root-url">Root page URL</Label>
      <Textfield
        id="root-url"
        value={value}
        onChange={onChange}
        placeholder={
          loadingDefault
            ? "Loading default…"
            : "https://your-site.atlassian.net/wiki/spaces/KEY/pages/123456/Title"
        }
        isDisabled={disabled}
      />
    </Stack>
  );
}

function DepthField({
  depth,
  disabled,
  onChange,
}: {
  depth: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Stack space="space.050">
      <Label labelFor="depth">Depth cap: {depth}</Label>
      <Range
        id="depth"
        min={1}
        max={5}
        step={1}
        value={depth}
        onChange={onChange}
        isDisabled={disabled}
      />
    </Stack>
  );
}

function BundleSlugField({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (event: TextfieldChangeEvent) => void;
}) {
  return (
    <Stack space="space.050">
      <Label labelFor="bundle-slug">Bundle slug</Label>
      <Textfield
        id="bundle-slug"
        value={value}
        onChange={onChange}
        isDisabled={disabled}
      />
    </Stack>
  );
}

function StartErrorMessage({ error }: { error: string | null }) {
  return (
    error && (
      <SectionMessage appearance="error">
        <Text>{error}</Text>
      </SectionMessage>
    )
  );
}

function StartButton({
  starting,
  rootUrl,
  onStart,
}: {
  starting: boolean;
  rootUrl: string;
  onStart: () => void;
}) {
  return (
    <Inline>
      <Button
        appearance="primary"
        onClick={onStart}
        isDisabled={starting || !rootUrl}
      >
        {starting ? "Starting…" : "Start export"}
      </Button>
    </Inline>
  );
}

export function ExportStartForm({
  values,
  state,
  handlers,
}: ExportStartFormProps) {
  const { rootUrl, depth, bundleSlug } = values;
  const { loadingDefault, starting, startError } = state;
  const { onRootUrlChange, onDepthChange, onBundleSlugChange, onStart } =
    handlers;
  return (
    <Stack space="space.150">
      <RootUrlField
        value={rootUrl}
        loadingDefault={loadingDefault}
        disabled={starting}
        onChange={onRootUrlChange}
      />
      <DepthField depth={depth} disabled={starting} onChange={onDepthChange} />
      <BundleSlugField
        value={bundleSlug}
        disabled={starting}
        onChange={onBundleSlugChange}
      />
      <StartErrorMessage error={startError} />
      <StartButton starting={starting} rootUrl={rootUrl} onStart={onStart} />
    </Stack>
  );
}

interface ExportRunPanelView {
  job: ExportJobView;
  skipped: SkippedPageView[];
  isRunning: boolean;
  isTerminal: boolean;
  cancelling: boolean;
  downloadUrl: string | null;
}

interface ExportRunPanelProps {
  view: ExportRunPanelView;
  onCancel: () => void;
  onReset: () => void;
}

function RunSummary({
  job,
  skipped,
}: {
  job: ExportJobView;
  skipped: SkippedPageView[];
}) {
  return (
    <Inline space="space.100">
      <Lozenge appearance={lozengeAppearanceFor(job.status)}>
        {stageLabel(job.stage)}
      </Lozenge>
      <Text>
        Exported {job.exportedCount || 0} pages
        {skipped.length > 0 ? `, ${skipped.length} skipped` : ""}.
      </Text>
    </Inline>
  );
}

function CancelAction({
  job,
  isRunning,
  cancelling,
  onCancel,
}: {
  job: ExportJobView;
  isRunning: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  if (!isRunning) {
    return null;
  }
  return (
    <Inline>
      <Button
        appearance="subtle"
        onClick={onCancel}
        isDisabled={cancelling || Boolean(job.cancelRequested)}
      >
        {cancelButtonText(cancelling, Boolean(job.cancelRequested))}
      </Button>
    </Inline>
  );
}

function cancelButtonText(
  cancelling: boolean,
  cancelRequested: boolean,
): string {
  if (cancelling) {
    return "Cancelling…";
  }
  return cancelRequested ? "Cancel requested…" : "Cancel";
}

function JobOutcomeMessage({
  job,
  downloadUrl,
}: {
  job: ExportJobView;
  downloadUrl: string | null;
}) {
  const messages = {
    failed: <FailedJobMessage job={job} />,
    cancelled: <CancelledJobMessage />,
    ready: <ReadyJobMessage job={job} downloadUrl={downloadUrl} />,
  };
  return messages[job.status as keyof typeof messages] ?? null;
}

function FailedJobMessage({ job }: { job: ExportJobView }) {
  return (
    <SectionMessage appearance="error" title="Export failed">
      <Text>{job.errorMessage}</Text>
    </SectionMessage>
  );
}

function CancelledJobMessage() {
  return (
    <SectionMessage appearance="warning" title="Export cancelled">
      <Text>The export was cancelled.</Text>
    </SectionMessage>
  );
}

function ReadyJobMessage({
  job,
  downloadUrl,
}: {
  job: ExportJobView;
  downloadUrl: string | null;
}) {
  if (!downloadUrl) {
    return (
      <SectionMessage appearance="success" title="Bundle ready">
        <Text>Preparing download link…</Text>
      </SectionMessage>
    );
  }
  return (
    <SectionMessage appearance="success" title="Bundle ready">
      <Link href={downloadUrl} openNewTab>
        Download {job.bundleSlug}.zip
      </Link>
    </SectionMessage>
  );
}

function SkippedPages({ skipped }: { skipped: SkippedPageView[] }) {
  return (
    skipped.length > 0 && (
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
    )
  );
}

function ResetAction({
  isTerminal,
  onReset,
}: {
  isTerminal: boolean;
  onReset: () => void;
}) {
  return (
    isTerminal && (
      <Inline>
        <Button onClick={onReset}>Start a new export</Button>
      </Inline>
    )
  );
}

export function ExportRunPanel({
  view,
  onCancel,
  onReset,
}: ExportRunPanelProps) {
  const { job, skipped, isRunning, isTerminal, cancelling, downloadUrl } = view;
  return (
    <Stack space="space.150">
      <RunSummary job={job} skipped={skipped} />
      <CancelAction
        job={job}
        isRunning={isRunning}
        cancelling={cancelling}
        onCancel={onCancel}
      />
      <JobOutcomeMessage job={job} downloadUrl={downloadUrl} />
      <SkippedPages skipped={skipped} />
      <ResetAction isTerminal={isTerminal} onReset={onReset} />
    </Stack>
  );
}
