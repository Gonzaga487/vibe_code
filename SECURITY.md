# Security policy

## Reporting

Report suspected vulnerabilities privately to the station owner/operator. Do not include production credentials, access tokens, password hashes, or unredacted database snapshots in tickets or chat messages.

## Deployment requirements

- Use a unique `JWT_SECRET` of at least 40 bytes with upper- and lowercase letters, a number, and a symbol.
- Set `FRONTEND_ORIGINS` to the exact deployed web origins; wildcard origins are rejected.
- Set `DATABASE_URL` to a path on a persistent, backed-up disk. SQLite is intended for a single backend replica.
- Set explicit first-admin bootstrap variables only for the first secure startup, then remove the password from the platform environment.
- Terminate TLS at the hosting platform and keep Render/Railway private-service access restricted.
- Restrict access to JSON backup files. They contain password hashes and complete station operations.
- Rotate credentials immediately after suspected disclosure and preserve the audit trail.

## Application controls

The API hashes passwords with bcrypt, uses short-lived signed access tokens, validates role selection at login, applies hard backend authorization checks, and sanitizes attendant responses. Administrative and destructive actions are audit logged. Production startup rejects weak JWT secrets and improper CORS configuration.
