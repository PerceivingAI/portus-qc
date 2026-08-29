# Portus QC Local Data

Portus QC is a local-first, single-user application. Structured state, secrets, retained media, and user-facing artifacts are deliberately separated.

## Default data root

Unless `PORTUS_QC_DATA_ROOT` is set:

- Windows: `%LOCALAPPDATA%\Portus QC`
- macOS: `~/Library/Application Support/Portus QC`
- Linux/other POSIX: `$XDG_DATA_HOME/portus-qc` or `~/.local/share/portus-qc`

An explicit `PORTUS_QC_DATA_ROOT` must be absolute.

## Layout

```text
<data-root>/
├── state/
│   └── portus-qc.sqlite
├── secrets/
│   └── <opaque-hash>.secret
└── media/
    └── YYYY-MM-DD/
        ├── capture/
        ├── frame/
        └── clip/
```

A configured media root may place internal media elsewhere.

## SQLite structured state

`state/portus-qc.sqlite` stores non-secret application settings, saved camera metadata, inspections, scheduled tasks, and normalized inspection results including capability-specific spatial child records.

Completed result records preserve prompt/capability/provider/source metadata needed to reconstruct stored results independently of later camera or inspection edits.

Camera credentials and Moondream keys are not stored in SQLite.

## Secrets

Secrets are handled through `SecretStore`. The current local implementation stores secret values separately under `<data-root>/secrets/` using opaque hashed filenames and user-private file modes where the platform supports them.

This protects against accidental disclosure through ordinary application state; it is not intended to protect secrets from an attacker with sufficient access to the user's operating-system account or machine.

## Internal media

The filesystem media store owns retained captures, analyzed video frames, and temporary clips. Paths are contained beneath the configured media root and traversal outside that root is rejected.

Retention is capability-neutral and bounded by configured age, file-count, and byte limits. Removing an older retained source file does not remove the authoritative structured SQLite result.

## User-facing artifacts

Artifacts default to the current user's actual Downloads directory under:

```text
Downloads/portus-qc-results
```

Query/Caption export as text. Detect/Segment/Point export as locally rendered images. Changing the artifact root affects later exports only; it does not move SQLite, secrets, or internal media.

Exported artifacts are not the database of record.

## Browser boundary

The browser Console accesses local state only through the loopback service. It does not open SQLite directly, construct authoritative media paths, spawn Camsnap/FFmpeg, or receive secret values through ordinary state/Doctor/result APIs.

The explicit secret-read exceptions are protected local Console endpoints used to populate masked editable credential fields for Moondream Settings and Edit Camera.
