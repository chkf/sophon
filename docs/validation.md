# Extraction validation

Local validation completed on Windows with Node.js 24.19.0.

- TypeScript check: passed.
- The full automated suite passed with one Windows symbolic-link privilege skip and no failures. Coverage includes local context, expression settings, conversation history, delivery, generic API/provider routing, channel authorization, logging and voice.
- Build: passed.
- Compiled CLI smoke check: fresh database initialization, Markdown Core export/import, refusal to overwrite existing state, correct nonzero readiness result without configured credentials/channels, and timestamped logging of a failed service start. Ordinary CLI commands did not create log files.
- Generic API integration: a local mock HTTP server accepted the compiled CLI's custom Chat Completions request. Configuration checks and manual model listing made no network requests; the diagnostic required explicit authorization. Separate tests exercise streaming, JSON, local tools and prevention of duplicate requests after uncertain outcomes. No external model service was called.
- Repository assembled from selected tracked source files with a new Git history. Runtime data, credentials, optional vendor code, private submodules and original repository history are excluded.
- Static private-content and credential-pattern review found no confirmed remaining private identity, account UUID, endpoint or credential. Pattern scans are checks, not a proof that all possible secret formats have been detected.

The default installation and test suite do not require the optional SIWC DevKit or any private repository. Install ffmpeg and ffprobe locally for audio integration tests. Run verification with `npm run typecheck`, `npm test` and `npm run build`.

Real Telegram delivery, iLink login, API billing and ChatGPT sign-in were not exercised with live credentials. Deployment and live-provider acceptance remain operator-specific. Optional SIWC keeps its upstream noncommercial license.
