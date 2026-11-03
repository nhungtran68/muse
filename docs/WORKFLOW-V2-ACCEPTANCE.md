# Workflow v2 acceptance (in progress)

Do not mark complete until all requested cases have evidence.

- Preserve raw customer input; structured analysis, storyboard, dialogue and timing per scene.
- Vietnamese syllable estimate plus actual audio transcript/timestamps before success.
- Per-user request identity, idempotency key and input/image fingerprint.
- Atomic FIFO queue, one leased Muse resource, fenced worker updates and attempt-specific outputs.
- Error isolation, bounded safe retry, preserved completed scenes and uncertain submissions.
- RLS and authenticated downloads for jobs, prompts, dialogue, references and MP4.
- Separate real local Auth/Postgres/Storage acceptance environment; then production migration/deployment checks.

Required real cases: single member; consecutive jobs; simultaneous two members; same-mode different content; different images/durations; success plus failure; reload during work; history/RLS/files; spoken timing; final files not mixed. Probe 8 seconds explicitly; never silently substitute duration.

Production history and stored media must be retained. The currently running production worker is v1.5.2; do not point it at v2 jobs.
