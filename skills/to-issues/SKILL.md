---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable, technically rich issues using vertical slices (tracer bullets).

Ralph supplies the accepted PRD and stage identity explicitly. No tracker or setup prerequisite is required.

## Process

### 1. Gather context

Read the exact accepted PRD content/revision/hash, approved explanation, pinned commit,
repository context and approved commands in the stage prompt. Do not rely on
conversation inheritance. Confirm referenced code and repository instructions.

### 2. Explore the codebase (REQUIRED)

Before drafting any issues, deeply explore the codebase. The goal is to collect the raw technical material that will make each issue self-sufficient — an agent picking up the issue should not need to do their own research.

Gather:

- **Relevant existing files** — find files each slice will touch or mirror, with line numbers
- **Patterns to follow** — naming conventions, error handling, API shape, data model patterns; extract real code examples
- **Integration points** — where new code registers, connects, or replaces existing code (routers, DI containers, index files, config)
- **Test examples** — find the closest existing test to each slice so the pattern is concrete
- **Gotchas and constraints** — things the codebase enforces that an agent wouldn't know from the spec alone (e.g. "all routes go through X middleware", "models must extend Y base class")
- **Validation commands** — the exact runnable commands to verify correctness (lint, type check, test, curl examples)

Check CLAUDE.md and any ADRs in `docs/adr/` for project-specific rules that must be respected.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Check the breakdown

Check granularity, dependency relationships, story coverage, and HITL/AFK choices
against the approved PRD. Do not quiz the user or request breakdown approval.
Ask a native question only for a genuinely missing product decision; a scope
change requires renewed explanation approval.

### 5. Write local issues and graph

Use ralph_write_planning_file({runId, attempt, path, content}) exclusively.
Write issues/<number>-<kebab-case-title>.md and graph.json in the run's supplied
issues-draft-<attempt> directory. Number slices in dependency order, blockers first.
Do not create external tracker issues or write .agents/issues or project code.
Include title, Type (HITL/AFK), covered user stories and requirements in each file.

Each issue must be **technically self-sufficient**: an AI agent picking it up cold should be able to implement it correctly without doing additional research. Fill every section with specifics from your codebase exploration — never leave placeholder text.

<issue-template>
## Parent

The exact accepted local PRD revision/path and covered user stories.

## What to build

A precise description of this vertical slice — the end-to-end behavior it delivers, which layers it touches, and how it fits into the broader system. Be concrete: name the files, components, endpoints, and data shapes involved. 3–6 sentences.

## Context: files to read before implementing

List every file an implementor must read before touching anything. Include line ranges and a one-line reason for each.

- `path/to/file.ts` (lines N–M) — reason: contains the pattern this slice must mirror
- `path/to/router.ts` (line N) — reason: where the new route must be registered
- `path/to/model.ts` — reason: data shape this slice extends

## Patterns to follow

Extract concrete patterns from the codebase — include actual code snippets or file:line references. Cover:

**Naming / file conventions:**
```
e.g. all API handlers live in src/api/<resource>/handler.ts and export a named Router
```

**Error handling:**
```typescript
// e.g. mirror the pattern at src/api/projects/handler.ts:42
throw new AppError(404, 'Resource not found')
```

**Data model / schema pattern:**
```
e.g. all Prisma models use snake_case columns; enums are defined in src/types/enums.ts
```

**Test pattern:**
```typescript
// e.g. integration tests use the factory at tests/helpers/factories.ts; see tests/api/projects.test.ts
```

Add or remove pattern sections as relevant to this slice.

## Step-by-step tasks

Execute in order. Each task is atomic.

### {ACTION} `path/to/file`

- **IMPLEMENT**: specific detail of what to write
- **PATTERN**: `path/to/existing/file.ts:line` — what pattern to mirror
- **IMPORTS**: list exact imports needed and where they come from
- **GOTCHA**: known constraint or non-obvious requirement
- **VALIDATE**: `npm run typecheck` or equivalent runnable command

Repeat for each file touched by this slice.

## Acceptance criteria

- [ ] Specific, observable criterion
- [ ] API contract: exact endpoint, method, request shape, response shape
- [ ] UI behavior (if applicable): specific user action → specific outcome
- [ ] Error cases handled (list them)
- [ ] Tests pass: `<exact test command>`

## Validation commands

```bash
# Type / lint
npm run typecheck && npm run lint

# Tests for this slice
npm test -- --testPathPattern="<relevant pattern>"

# Manual smoke test (replace with real values)
curl -X POST http://localhost:3000/api/... -d '{"key":"value"}'
```

## Blocked by

- #N — short reason why it must come first

Or "None — can start immediately."

</issue-template>

Do NOT close or modify any parent issue.

## Ralph graph and completion contract

The stage prompt supplies the strict graph schema and exact prdRevision object.
Each graph issue includes a unique id, title, safe artifactPath, dependency IDs,
nonempty acceptanceCriteria and testableBehaviors. Include every local issue
exactly once. No missing dependencies or cycles are allowed.
Required nonempty Markdown sections are What to build, Context: files to read
before implementing, Patterns to follow, Step-by-step tasks, Acceptance criteria,
Validation commands, and Blocked by. Include concrete code/test references.
Keep validation commands exactly as approved; never add invented commands.

After authoring the local files, call ralph_complete_issues with the run/attempt
and graph path when that tool is available. If unavailable, preserve the drafts
and report the blocker. Ordinary final messages cannot complete the stage.
The host validates and accepts the bundle before execution can start.
No second execution approval, tracker setup, or breakdown review is required.
Do not execute shell commands, implement code, delegate, or start execution.

## Stage-owned product questions

Call ralph_request_product_decision({runId, attempt, question, recommendation})
for missing product decisions. The host persists the request and real native answer.
A same-scope clarification continues in this stage without another approval.
If the answer changes scope, call the tool with revisedExplanation: {text, scope,
criteria}; the host always requests separate explanation approval and invalidates
dependent accepted drafts. Do not treat a clarification answer as scope approval.
Resume writing only from the revised stage prompt and its current artifact inputs.
Technical choices already within approved scope need no extra approval.
