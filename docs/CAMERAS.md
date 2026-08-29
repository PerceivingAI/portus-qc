# Portus QC Cameras

Portus QC uses Camsnap as its network-camera integration path. The application owns saved-camera state, credential storage, local API orchestration, diagnostics, and the four-slot Camera Management UI; the reusable `@portus-qc/camsnap` package owns product-neutral Camsnap behavior.

## Saved camera state

Portus QC supports at most four configured cameras in ordered slots `1..4`.

Non-secret camera metadata includes:

```text
stable camera id
slot 1..4
optional alias
host / optional port
rtsp | rtsps
stream1 | stream2
optional explicit stream path
tcp | udp
gortsplib | ffmpeg RTSP client
auto | basic | digest RTSP auth
```

Camera-local username/password are never stored in the camera table. They are stored through `SecretStore` and ordinary camera/Doctor responses expose only whether credentials are configured.

## Camera preparation

Most network cameras require local RTSP/ONVIF access to be enabled separately from the vendor cloud account. Use the camera-local streaming account in Portus QC, not necessarily the vendor/cloud login.

For cameras that expose it, enable RTSP/local streaming and create a local camera account before connecting. Repeated authentication failures can trigger camera-side lockout, so Portus QC performs bounded explicit connection attempts instead of aggressive retries.

## Discovery and manual fallback

Camera registration uses one path:

```text
empty slot
→ Camera Editor
→ Discover Cameras
→ select a candidate or enter host/IP manually
→ enter optional alias and camera-local credentials
→ Connect
```

Discovery candidates are suggestions only. Selecting a discovery candidate fills the host; a discovery/device-service port is not automatically treated as the RTSP port.

## Atomic Connect

`POST /api/cameras/_actions/connect` validates the requested configuration and credentials, performs exactly one Camsnap validation snapshot through the configured production RTSP client, and persists the camera only after success.

A failed Connect stores neither camera metadata nor credentials.

Normalized camera failures include:

```text
not_found
unreachable
auth_invalid
server_locked
timeout
stream_unavailable
process_failed
invalid_output
```

## Editing, deletion, and slot movement

Editing may change alias, network settings, Camsnap options, and credentials. The protected local Console credential read is used only to populate the Edit form; the password remains masked until explicitly revealed.

Moving a camera to another slot preserves its stable ID. If the destination slot is occupied, the repository swaps the two slot assignments atomically.

Deleting a camera removes its saved camera metadata and credentials.

## Preview and Refresh

`POST /api/cameras/:id/preview` returns a browser-safe still preview. It does not create an inspection result, artifact, or Moondream request.

Camera Management **Refresh** reloads persisted slot definitions and retries one fresh preview/connection for each configured camera. Failed refreshes do not keep presenting a stale thumbnail as current.

## Inspection acquisition

Normal camera inspection is:

```text
selected saved camera
→ one Camsnap snapshot
→ saved prompt + one selected capability
→ exactly one Moondream request
→ normalized result
→ SQLite result + artifact export
```

The still captured for inference is not staged into the Input pane; Input remains the selected camera preview/feed.

## Calibration Report

Calibration targets the exact media already visible in Input. For a camera source, Portus QC submits the already-rendered preview image and does not capture a second camera still. For File input, it uses the selected file image.

The report evaluates Lighting, Obstruction, Focus, Glare, and Framing. It is informational only and never blocks an inspection.

## Doctor

`npm run doctor` checks Camsnap executable availability and adds a reachability check for each saved camera when Camsnap is available. Credentials are never included in Doctor output.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for remediation guidance.
