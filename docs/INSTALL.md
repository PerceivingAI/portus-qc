# Installing and Running Portus QC

## Requirements

- Node.js 22.13.0 or newer.
- npm with lockfile v3 support.
- A Moondream API key for hosted inference and Calibration Report.
- FFmpeg for Video frame extraction.
- The bundled Camsnap Windows x64 executable for the normal Windows camera path. Other supported environments may use an explicitly configured Camsnap executable.

## Install

From the repository root:

```bash
npm ci
```

The committed lockfile is authoritative. The root npm configuration denies the dev-time `esbuild` install script because the verified source build and test flow do not require it.

## Verify

Run the deterministic source gate:

```bash
npm run verify
```

This typechecks and tests the reusable engine packages and bundled application, syntax-checks the browser modules, verifies package boundaries, validates release metadata, and verifies the bundled Camsnap checksum.

The deterministic test gate does not require production credentials, network access, or a physical camera.

## Check local readiness

```bash
npm run doctor
```

Doctor reports Node compatibility, local data-directory writability, Moondream-key presence, Camsnap resolution, FFmpeg resolution, and saved-camera reachability where applicable. It does not print saved credentials and does not claim that a configured Moondream key is valid until a real inference succeeds.

## Configure Moondream

Launch users normally set the model and API key through the gear Settings modal. The key is masked by default and can be explicitly revealed with the eye control.

A repository-root `.env` may be used as a local fallback:

```text
MOONDREAM_API_KEY=your_key_here
```

Key precedence is:

```text
GUI-saved key
→ repository-root .env key
→ unconfigured
```

Do not commit `.env`.

## Start the application

```bash
npm start
```

By default the local service binds only to:

```text
http://127.0.0.1:3210
```

and opens the Console automatically. Keep the terminal process running while using the application. Closing the last Console tab/window stops the local service after a short refresh-safe grace period. `Ctrl+C` remains the explicit terminal shutdown path.

## Add a camera

Open Camera Management, choose an empty slot, then use Camera Editor:

```text
Discover Cameras
→ select a discovery candidate or enter a host manually
→ enter camera-local username and password
→ Connect
```

Connect performs one bounded validation capture and persists the camera only on success. Camera credentials are stored separately from SQLite camera metadata.

See [CAMERAS.md](CAMERAS.md).

## Run inspections

- **Image + On demand** — **Capture & Inspect** captures one still from the selected camera and performs exactly one selected capability request.
- **Image + Scheduled** — manage up to 10 service-owned recurring still tasks, each with its own camera, prompt, capability, interval, and enabled state.
- **Video + On demand** — Start/Stop a camera video session. Camsnap records short chunks, FFmpeg extracts frames, and excess frame opportunities are dropped rather than queued.
- **File + On demand** — select JPEG/PNG locally, then **Capture & Inspect** uploads and normalizes that file once before the normal process path. No camera is required.

Scheduled Video is not supported.

## Results

Human-facing artifacts default to:

```text
Downloads/portus-qc-results
```

Structured results remain authoritative in local SQLite. See [LOCAL_DATA.md](LOCAL_DATA.md).

For problems, run `npm run doctor` and then see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
