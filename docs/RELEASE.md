# Portus QC Public Release Checklist

This checklist separates deterministic source verification from external provider/hardware acceptance.

## 1. Deterministic source gate

From a clean source checkout:

```bash
npm ci
npm run verify
```

Required outcome:

- dependency install succeeds from the committed lockfile;
- engine structure/type/tests pass;
- bundled application type/browser/tests pass;
- release metadata/public-file checks pass;
- the pinned bundled Camsnap checksum matches provenance.

The deterministic test gate is intentionally independent of production credentials, network access, and physical cameras.

## 2. Dependency and vulnerability review

For each release candidate:

```bash
npm audit
npm ls --all
npm install-scripts ls
```

Review `THIRD_PARTY.md` against the resolved dependency tree. Do not silently approve new dependency install scripts.

If the bundled Camsnap version changes, update and verify its MIT notice, provenance, checksum, and dependency-license review. FFmpeg is not redistributed; redistribution would require a separate build-specific license/provenance review.

## 3. Public-source hygiene

Before publishing:

- confirm `LICENSE` is Apache-2.0 and every workspace manifest declares `Apache-2.0`;
- keep root and bundled app workspaces `private: true` to prevent accidental npm publication;
- confirm `SECURITY.md` and `THIRD_PARTY.md` are current;
- confirm README/INSTALL describe the actual launch flow;
- ensure `.env`, local application data, `node_modules`, generated artifacts/logs, browser profiles, and local machine paths are absent;
- ensure no API key, camera password, private camera address, personal account identifier, or other local secret is present;
- confirm the committed lockfile matches the release candidate install.

`npm run verify:release` checks the machine-readable subset of these rules.

## 4. Local runtime Doctor

```bash
npm run doctor
```

Resolve unexpected `ERROR` states and review every `ATTENTION` relevant to the workflows being released.

Doctor proves local prerequisite state only. A configured Moondream key still requires successful real inference before provider validity can be claimed.

## 5. Manual external acceptance

### Moondream

- start the application and open Settings;
- confirm the API key is masked by default and reveal/hide works;
- save/replace a user-provided key and model;
- confirm clearing the key restores `.env` fallback where present;
- run a real inference successfully;
- confirm invalid credentials produce an actionable error without exposing key material.

### Camera

With a supported real network camera:

- Doctor reports Camsnap available;
- discovery or manual host fallback reaches Camera Editor;
- Connect validates once and persists only on success;
- camera state survives service restart;
- preview and Camera Management Refresh work;
- camera Doctor/Test reachability works;
- Edit/Delete/slot movement behave correctly without exposing credentials;
- authentication failure/lockout handling remains bounded and safe.

### Calibration Report

- with a camera preview visible in Input, run Calibration and confirm no second camera capture occurs;
- with a File image visible, confirm that exact selected image is used;
- confirm opening/canceling the File picker does not silently change the visible calibration source;
- verify Lighting, Obstruction, Focus, Glare, and Framing are returned or normalized safely;
- confirm calibration is informational and does not block inspection or mutate Input.

### Inspection capabilities

Use representative real images and verify transport/rendering for:

- Query → text + Copy;
- Detect → boxes;
- Segment → region/mask overlay;
- Point → markers;
- Caption → descriptive text.

This validates application routing/rendering, not model accuracy.

### Scheduled stills

- create an enabled recurring task with its own camera, prompt, capability, and interval;
- verify main Console prompt/capability changes do not mutate the task;
- verify results persist and overlap is dropped rather than queued;
- verify Arm/Disarm, Edit, Delete, restart restoration, and the 10-task limit.

### Video

- confirm FFmpeg is available;
- start Video + On demand and observe sampled results;
- verify source-changing controls are frozen while active;
- verify accepted frames persist as `video-frame` results;
- verify excess frame opportunities are dropped rather than queued;
- keep the session running beyond 10 minutes and confirm it continues until explicit Stop, failure, or service shutdown;
- verify Stop drains cleanly and browser reopening can reattach only to an active session.

## 6. Claim boundary

A release may claim the documented engine/application workflows and verified integration contracts. It must not claim universal camera compatibility, Moondream accuracy, defect-detection performance, or calibration guarantees without representative evidence supporting those claims.
