# Third-Party Components

This repository contains Portus QC source code, selected integration adapters, and the validated upstream Camsnap Windows x64 executable used by the application camera runtime. It does not vendor model weights, SDK source trees, `node_modules`, or FFmpeg.

## Camsnap

Portus QC includes both its Camsnap adapter/runtime wrapper and the validated upstream Windows x64 Camsnap executable used by the normal Windows application path.

Upstream Camsnap is licensed under the MIT License, copyright (c) 2025 Peter Steinberger. The required notice is preserved at `apps/portus-qc/vendor/camsnap/LICENSE.txt`. Exact bundled version/provenance/checksum information is recorded in `apps/portus-qc/vendor/camsnap/PROVENANCE.md`.

For every Portus QC release that includes Camsnap:

- preserve the upstream Camsnap MIT copyright and permission notice;
- verify the exact bundled Camsnap version and binary checksum against the recorded provenance;
- review the licenses/notices of dependencies incorporated into the selected binary when that version changes;
- keep FFmpeg separate unless the selected FFmpeg build, codecs, license configuration, notices, and redistribution obligations have been reviewed for that release.

Camsnap also documents that saved camera credentials are stored in its configuration file in plaintext with user-only permissions. Its documented camera setup accepts the password through the `--pass` command-line option. The Portus QC Node runtime follows that documented CLI contract. Applications using the adapter should use a user-private configuration location, treat the local machine as trusted, avoid logging process arguments, and disclose that camera credentials may be transiently visible to sufficiently privileged local process inspection.

## FFmpeg

Portus QC does not redistribute FFmpeg. The launch bounded Video workflow requires a separately installed FFmpeg executable for local MP4-frame extraction, and some Camsnap configurations may also select FFmpeg as their RTSP client.

FFmpeg licensing depends on the exact build configuration and enabled libraries/codecs. A future binary distribution must inventory the exact build, licence configuration, notices, provenance, and redistribution obligations rather than treating `ffmpeg` as a single universal licence choice.

## Moondream

Portus QC includes a source-only `VisionProvider` adapter for the Moondream cloud API. It does **not** redistribute Moondream model weights, SDK code, or service credentials.

Callers provide their own API key at runtime. The adapter uses the documented direct API base URL and `X-Moondream-Auth` request header and supports query, detect, point, caption, and segment capabilities. Use of the external Moondream service remains subject to the terms and policies applicable to the caller's Moondream account.

## Sharp / libvips and runtime npm tree

The bundled local application uses `sharp` to decode source images, composite Portus QC's local SVG overlays, and write PNG result artifacts. Rendering remains local and is not used to send inference data elsewhere.

The resolved Windows x64 runtime tree verified on 2026-08-28 after `npm ci` contained:

| Package | Version | Declared license |
| --- | --- | --- |
| `sharp` | 0.35.4 | Apache-2.0 |
| `@img/colour` | 1.1.0 | MIT |
| `@img/sharp-win32-x64` | 0.35.4 | Apache-2.0 AND LGPL-3.0-or-later |
| `detect-libc` | 2.1.2 | Apache-2.0 |
| `semver` | 7.8.5 | ISC |

Sharp uses platform-specific optional packages. Public releases must re-check the resolved tree on each target platform and preserve all required notices. The table above is evidence for the audited Windows x64 install, not a claim that every platform resolves the same native package set.

## Development and verification tooling

The source workspace declares development dependencies used to typecheck and run the offline verification suites. These packages are downloaded by npm and are not committed to this repository.

The Windows verification tree audited on 2026-08-28 contained:

| Package | Version | Declared license |
| --- | --- | --- |
| `@types/node` | 26.4.0 | MIT |
| `tsx` | 4.23.12 | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |
| `esbuild` | 0.28.2 | MIT |
| `@esbuild/win32-x64` | 0.28.2 | MIT |
| `undici-types` | 8.3.0 | MIT |
| `@typescript/typescript-win32-x64` | 7.0.2 | Apache-2.0 |
| `vscode-jsonrpc` | 9.0.0 | MIT |

npm 12 identifies `esbuild` as having a dev-time postinstall script. Portus QC explicitly denies that script in the root `allowScripts` policy. A clean `npm ci` and the complete repository verification gate pass with the script disabled. Do not approve a new install script silently; review the dependency and release implications first.

`npm audit` reported zero known vulnerabilities for the repository workspace on 2026-08-28. Dependency and advisory state must be re-audited for each public release.
