# Service Development Guidelines

Placeholder. The canonical
`provider-platform/docs/service-development-guidelines.md` covers patterns
specific to that service (DB-backed PP key management, council membership
routing). This service has no database and no application state —
council/PP/channel topology is discovered at runtime from `council-platform` and
Soroban.

See top-level `README.md` for the service architecture and the WebSocket frame
protocol. See `TROUBLESHOOTING.md` for deploy and runtime debugging.
