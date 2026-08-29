# Security Policy

## Reporting a vulnerability

Please use GitHub private vulnerability reporting for security issues when it is enabled on the repository. Do not publish credential material, camera addresses, API keys, or exploit details in a public issue.

If private vulnerability reporting is not available, open a minimal public issue asking for a private contact channel without including sensitive details.

## Scope

Security reports may cover the engine, the Moondream adapter, the Camsnap adapter/runtime wrapper, dependency or credential-handling issues, and repository release artifacts. Third-party services and executables should also be reported to their respective upstream maintainers when appropriate.

## Credentials

Portus QC does not ship service credentials. Moondream API keys and camera credentials are supplied by the caller at runtime.

The bundled local application keeps secrets outside its SQLite structured-state database behind a `SecretStore` abstraction. The launch implementation stores secret values in separate local files with opaque hashed filenames and user-private permission modes where supported. This is a single-user local security boundary, not protection against an attacker with sufficient access to the user's machine.

See `docs/LOCAL_DATA.md` for the local storage boundary and `THIRD_PARTY.md` for Camsnap's own credential-storage and process-argument behavior.
