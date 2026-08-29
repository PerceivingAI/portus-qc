# Portus QC

Portus QC is an Apache-2.0 visual-quality screening engine with a bundled local application for camera- and image-based inspection workflows.

The source tree contains reusable engine packages, a provider-neutral result model, a Moondream vision adapter, a Camsnap network-camera adapter/runtime, and a local browser Console backed by a loopback-only Node service with SQLite state.

## Requirements

- Node.js 22.13.0 or newer.
- npm with lockfile v3 support.
- A Moondream API key for hosted inference and Calibration Report.
- FFmpeg for Video frame extraction.
- On Windows x64, the validated Camsnap executable is bundled with the application.

## Install and run

From the repository root:

```bash
npm ci
npm run verify
npm run doctor
npm start
```

`npm start` launches the local service on `http://127.0.0.1:3210` by default and opens the Console in the default browser. The service rejects non-loopback bind addresses.

A local Moondream fallback key may be placed in a gitignored repository-root `.env` file:

```text
MOONDREAM_API_KEY=your_key_here
```

The normal key precedence is GUI-saved key, then repository-root `.env`, then unconfigured. API keys and camera credentials are not stored in SQLite, results, artifacts, Doctor output, or ordinary logs.

## Application workflows

The Console supports three input modes:

- **Image** — inspect one still from the selected saved camera, either on demand or through scheduled still tasks.
- **Video** — on-demand Start/Stop analysis. Camsnap records short MP4 chunks, FFmpeg extracts frames, and accepted frames are inspected without building an inference backlog.
- **File** — choose a local JPEG or PNG. Selection stays browser-local until **Capture & Inspect** sends the image to the local service.

Each inspection has one prompt and exactly one selected Moondream capability:

```text
Query | Detect | Segment | Point | Caption
```

The service performs exactly one selected-capability request for each analyzed image or accepted video frame. Query and Caption produce text; Detect, Segment, and Point are rendered locally from normalized spatial results.

The **Calibration Report** evaluates the exact image currently visible in Input. It is informational only, uses one hidden Moondream Query, and does not block inspections or trigger a second camera capture.

## Camera support

Portus QC uses Camsnap as its network-camera integration path. The app supports discovery plus manual host fallback, camera-local credentials, four ordered saved camera slots, preview, refresh, edit/delete, and camera-specific Camsnap options.

See [docs/CAMERAS.md](docs/CAMERAS.md) for configuration and camera preparation guidance.

## Results and local data

Structured results are stored in local SQLite. User-facing artifacts default to the current user's Downloads directory under:

```text
Downloads/portus-qc-results
```

Query/Caption artifacts are text files; Detect/Segment/Point artifacts are locally rendered images. Internal source media, structured state, secrets, and user-facing artifacts remain separate.

See [docs/LOCAL_DATA.md](docs/LOCAL_DATA.md).

## Reusable packages

- `@portus-qc/contracts` — media, vision, evidence, result, and calibration contracts.
- `@portus-qc/media` — provider-neutral image preparation primitives.
- `@portus-qc/screening-core` — deterministic screening/calibration implementation.
- `@portus-qc/engine` — stable reusable engine facade and reference entrypoint.
- `@portus-qc/vision` — Moondream provider/classifier and request-gate primitives.
- `@portus-qc/camsnap` — product-neutral Camsnap adapter and Node runtime entrypoint.
- `@portus-qc/inspection-config` — validated prompt + one-capability inspection execution.

The reusable packages do not depend on the bundled application.

## Verification

```bash
npm run verify
```

The verification gate typechecks and tests the engine and bundled application, checks browser scripts, validates the repository structure, verifies release metadata, checks the pinned Camsnap binary checksum, and scans release-facing source for concrete developer-home paths.

Tests use deterministic or mocked external boundaries and do not require a real camera, network access, or production credentials. Hardware/provider acceptance remains a separate release step.

## Documentation

- [Installation](docs/INSTALL.md)
- [Configuration](docs/CONFIGURATION.md)
- [Cameras](docs/CAMERAS.md)
- [Moondream](docs/MOONDREAM.md)
- [Local data](docs/LOCAL_DATA.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Release checklist](docs/RELEASE.md)
- [Security policy](SECURITY.md)
- [Third-party components](THIRD_PARTY.md)

## License

Portus QC source is licensed under Apache-2.0. Third-party components retain their own licenses and terms; see [THIRD_PARTY.md](THIRD_PARTY.md).
