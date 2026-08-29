# Moondream Integration

Portus QC uses Moondream as a hosted visual-inference provider while keeping the public engine/provider contracts normalized and provider-neutral.

## Configuration

The application Settings modal stores the selected model as ordinary non-secret application configuration and stores the API key through `SecretStore`.

The repository default model is:

```text
moondream3.1-9B-A2B
```

A repository-root `.env` may provide a fallback key:

```text
MOONDREAM_API_KEY=your_key_here
```

The key is masked by default in Settings and is never written to SQLite, results, artifacts, Doctor output, or ordinary logs.

## Native inspection capabilities

Portus QC exposes the five native capabilities directly:

```text
query
caption
detect
point
segment
```

A saved inspection has one prompt and one selected capability. Each analyzed image/frame produces exactly one selected-capability request. There is no hidden secondary Query request and no automatic multi-skill router.

The adapter validates provider payloads and returns normalized results:

```text
query   → text
caption → text
detect  → normalized boxes
point   → normalized points
segment → normalized regions/path + bounding box
```

Malformed provider payloads fail at the vision boundary instead of leaking raw provider JSON into application code.

## Calibration Report

The bundled application Calibration Report is separate from normal inspection. It sends the exact image currently visible in Input through one hidden native Query that requests five fixed fields:

```text
lighting
obstruction
focus
glare
framing
```

Portus QC validates the response locally and produces normalized informational states. Missing or unusable fields become `unknown`. Calibration never blocks Capture & Inspect and does not trigger a second camera capture.

## Rate limiting and retries

The application owns one shared request-start gate across concurrent Moondream work. The default request-start limit is configured in `config/defaults/inference.json`.

Provider retries are bounded. HTTP 429 and common transient 5xx failures may be retried according to the configured policy; numeric `Retry-After` is honored when present.

Video sampling cadence is separate from the Cloud request-start ceiling. Frames that cannot be accepted immediately are dropped rather than queued.

## Media limits

Portus QC accepts JPEG and PNG for its direct application image paths and normalizes uploads before inference. File and Calibration uploads are bounded before normalization, and normalized inference images must fit within Moondream's 10 MB image limit.

## Error boundary

Typical hosted failures include invalid requests, invalid/missing credentials, oversized images, rate limiting, and provider failures. Application errors are normalized before reaching the UI and must not expose API keys or raw provider response data.

Moondream service usage remains subject to the terms applicable to the caller's Moondream account.
