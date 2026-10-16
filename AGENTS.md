# Working in this repository

Use standalone Bun from `.bun-version` and the pinned OpenCode dependencies.

Project setup must include both `bun run test` and `bun run test:status` among the proposed checks. The focused status command is for quick public-interface TDD cycles; the full integration suite remains mandatory for candidate integration and final validation. Their overlapping coverage is intentional. Do not change approved commands during a feature run. Run build, browser, package and test commands sequentially within one checkout: they share generated assets, so parallel invocation can race file removal and produce misleading tool diagnostics.

After meaningful behavior changes, update the relevant compact page in `docs/wiki` with the behavior, reason and code/test references.
