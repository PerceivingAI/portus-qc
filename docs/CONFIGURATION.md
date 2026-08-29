# Portus QC Configuration

Portus QC keeps variable runtime behavior in explicit configuration and keeps secrets outside ordinary configuration.

## Precedence

The application applies configuration in this order:

```text
repository defaults
→ persisted non-secret user settings
→ approved environment overrides
→ request/session-specific values
```

The merged configuration is validated before use. Invalid QC-relevant configuration fails closed.

## Repository defaults

Defaults live in `config/defaults/`:

- `runtime.json` — loopback host/port, browser opening, data root, Camsnap/FFmpeg executable names.
- `inference.json` — Moondream model, timeout, retry policy, request-start limit.
- `camera.json` — RTSP/Camsnap protocol, stream, transport, client, and authentication defaults.
- `console.json` — Console preferences such as selected camera.
- `scheduler.json` — interval bounds and overlap policy.
- `video.json` — sampling cadence and outstanding-inference bound.
- `media.json` — internal media root and retention limits.
- `artifacts.json` — user-facing result artifact root.

Machine-readable persisted-setting and camera/inspection schemas live in `config/schemas/`.

## Approved environment overrides

```text
PORTUS_QC_HOST
PORTUS_QC_PORT
PORTUS_QC_DATA_ROOT
PORTUS_QC_CAMSNAP_EXECUTABLE
PORTUS_QC_FFMPEG_EXECUTABLE
PORTUS_QC_MOONDREAM_TIMEOUT_MS
PORTUS_QC_MOONDREAM_MAX_ATTEMPTS
```

`PORTUS_QC_DATA_ROOT` must be absolute when set. Startup rejects non-loopback bind addresses even when host configuration is overridden.

On Windows x64, Camsnap resolution prefers an explicit configured executable, then the app-bundled executable, then a bare `camsnap` command on `PATH`.

## Moondream key and model

The model defaults to `moondream3.1-9B-A2B` and may be saved through the Settings UI.

The API key is handled by `SecretStore`, not by SQLite application settings. A repository-root `.env` provides the only file-based fallback:

```text
MOONDREAM_API_KEY=your_key_here
```

Key precedence is GUI-saved key → repository-root `.env` → unconfigured. A process-environment `MOONDREAM_API_KEY` is not used as the launch credential source.

Raw key material must not appear in ordinary settings responses, Doctor output, results, artifacts, or logs.

## Camera configuration

Saved non-secret camera metadata includes stable identity, ordered slot, optional alias, host/port, RTSP protocol/stream/path, transport, RTSP client, and RTSP authentication mode. Username/password remain in `SecretStore`.

## Inspections

A saved inspection has one prompt and one mutually exclusive capability:

```text
query | detect | segment | point | caption
```

Execution performs exactly that one capability. The application does not add a hidden decision request or automatic multi-capability fan-out.

## Scheduler

The default scheduler interval range is 10 seconds to 24 hours and overlap policy is `drop`. The service enforces a maximum of 10 scheduled tasks. Each task owns its camera, prompt, capability, interval, enabled state, and runtime status.

## Video

The default video configuration samples at 4 fps with one outstanding inference. Sampling cadence is separate from the shared Moondream request-start limit. If an inference cannot be accepted immediately, the frame opportunity is dropped rather than queued. Sessions run until Stop, failure, or service shutdown; there is no arbitrary maximum-duration timer.

## Local data and artifacts

Structured state, secrets, internal media, and user-facing artifacts are separate. The default artifact root is the current user's Downloads directory under `portus-qc-results`. Explicit artifact roots must be absolute.

See [LOCAL_DATA.md](LOCAL_DATA.md).
