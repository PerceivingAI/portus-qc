# Bundled Camsnap provenance

Portus QC bundles the upstream Camsnap command-line executable as part of the camera runtime.

## Windows x64

- Upstream: `steipete/camsnap`
- Version: `0.4.1`
- Artifact: official prebuilt Windows AMD64 release binary
- Bundled path: `windows-x64/camsnap.exe`
- Binary SHA-256: `3557a03cfc4232f2ade3ef2c68b610d3821caca6922ce1de89fe2076426e9479`
- License: MIT; see `LICENSE.txt`

The bundled binary is pinned by checksum and used by the normal Windows x64 camera runtime. Release acceptance should exercise this exact binary against the supported camera workflow documented in `docs/RELEASE.md`.

FFmpeg remains a separate runtime component and is not included in this Camsnap vendor directory.
