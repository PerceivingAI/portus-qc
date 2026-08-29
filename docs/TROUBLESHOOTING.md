# Portus QC Troubleshooting

## Start with Doctor

From the repository root:

```bash
npm run doctor
```

The running service exposes the same structured report at:

```text
GET /api/doctor
```

Doctor states are `ready`, `degraded`, or `error`; individual checks use `ok`, `attention`, or `error`. Doctor never prints saved API keys or camera passwords.

## Node.js

Portus QC requires Node.js 22.13.0 or newer because the bundled application uses Node's built-in SQLite module. An older runtime is a hard Doctor error.

## Local data

Doctor verifies that the active Portus QC data root is writable. Failure is a hard error because structured state, secrets, and internal media depend on that directory.

See [LOCAL_DATA.md](LOCAL_DATA.md).

## Moondream

Doctor checks whether an API key is available through the normal secret-resolution path. Key presence does not prove that the key/model is valid or that the provider is currently reachable.

If inference fails:

- confirm the key belongs to the intended Moondream account;
- confirm the configured model is available;
- review the normalized error instead of repeatedly retrying;
- never put the key in logs, issues, screenshots, or command output.

See [MOONDREAM.md](MOONDREAM.md).

## Camsnap

On Windows x64 the application normally uses the bundled Camsnap executable. If Doctor reports Camsnap unavailable, confirm this file exists and matches its recorded provenance:

```text
apps/portus-qc/vendor/camsnap/windows-x64/camsnap.exe
```

A nonstandard executable can be configured with:

```text
PORTUS_QC_CAMSNAP_EXECUTABLE=<absolute path>
```

Camera authentication failures should not be retried aggressively. Use the camera-local RTSP account and see [CAMERAS.md](CAMERAS.md) for preparation and lockout guidance.

## FFmpeg

Video requires FFmpeg for local frame extraction. Doctor resolves it and checks `ffmpeg -version` without a shell.

A nonstandard executable can be configured with:

```text
PORTUS_QC_FFMPEG_EXECUTABLE=<absolute path>
```

Missing FFmpeg does not prevent still-image workflows from starting.

## Video will not start

Confirm:

- a camera is selected and reachable;
- Camsnap is available;
- FFmpeg is available;
- Moondream is configured;
- the inspection prompt/capability is valid.

Video runs on demand only.

## Results cannot be written

The user-facing artifact directory is separate from the internal application data root. Confirm the Results path in the Console points to a writable local directory. Changing it does not move SQLite or secrets.

## Executable resolution

Runtime executable resolution is centralized in the local service:

- absolute configured paths must exist as regular files;
- relative paths containing separators resolve from the process working directory;
- bare executable names resolve through `PATH`;
- Windows resolution honors `PATHEXT`;
- child processes are launched with `shell: false`.

## What Doctor does not prove

Doctor is a readiness diagnostic, not a certification. It does not prove model accuracy, universal camera compatibility, calibration quality, or sustained Video throughput for every camera/network/provider combination.

Use [RELEASE.md](RELEASE.md) for manual external acceptance before making release claims.
