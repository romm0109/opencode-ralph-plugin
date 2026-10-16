# Command discovery

Explore the repository with read-only tools. Inspect manifests, scripts, documentation,
CI definitions and service dependencies. Discover existing directories with read-only listing/globbing before searching them; do not assume paths such as src/project exist. A missing exploratory path is recoverable: correct the path and continue. Propose a complete JSON lifecycle configuration
and rationale; do not run commands, edit files or treat a proposal as approval.

Use schemaVersion 1 and the requested revision. Each command has a unique stable id,
phase (setup, check, start, readiness, cleanup), executable, args array, relative cwd,
timeoutMs, platforms (darwin, linux, win32), and env mapping target variable names to
source environment variable names. A shell is optional and must name an explicit shell
for the applicable platform. Never include environment values or credentials.

Order commands by phase for each platform. Require a meaningful check for each supported
platform. Pair service startup with bounded readiness checks and cleanup. A readiness
command succeeds only when the service is ready; it may be retried until its deadline.
Explain absent scripts honestly. List unsupported platforms and reasons in
unsupportedPlatforms rather than silently excluding them. Optional url identifies the
local service for later consumers. Return JSON only, without fences. Approval and saving
are performed by the main-session workflow, independently of discovery.

For concurrent runtime isolation, propose optional `resources` mapping source names
(such as RALPH_PORT, RALPH_NAMESPACE, RALPH_DIRECTORY) to `port`, `namespace`, or
`directory`. Command `env` mappings reference those names. Only propose commands
the project supports; missing capabilities are explicit setup blockers. Use optional
`exclusiveResources` (stable resource names) when a shared resource cannot be isolated.
Startup without port allocation is serialized. Allocation is part of the exact approved
configuration, including setup verification; never change commands during execution.

`rationale` must be one non-empty JSON string, never an array or object. Use escaped newlines within that string for multiple paragraphs. Return the complete corrected configuration when a previous proposal fails schema validation; keep the requested revision and never execute proposed commands.
