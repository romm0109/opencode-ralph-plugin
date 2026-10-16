# Ralph task loop

## Summary

`ralph-loop.sh <folder> <iterations> [start_file]` runs the folder's Markdown tasks sequentially for each requested iteration.

## Key behavior

- Task paths use `sort -V` so numbered filenames run in natural order: 1, 2, …, 10.
- All top-level `.md` files are included, including `README.md` when present.
- The second argument counts full iterations, not tasks.

## Code references

- `ralph-loop.sh` — task discovery, ordering and execution loop; requires a `sort` implementation supporting `-V`.

## Last updated

2026-10-14
