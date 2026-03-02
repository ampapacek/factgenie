# AGENTS.md

## Environment
- Always use the project virtual environment for Python commands:
  - `./.venv/bin/python`
  - `./.venv/bin/pip`
- If a dependency is missing, propose/install it into `.venv` (not system Python).

## Workflow
- Document every code change clearly in responses:
  - what changed
  - which files changed
  - why it changed
- Keep commits small and logical.

## Git safety
- Before running prepared git commands, always ask first:
  - `git add ...`
  - `git commit ...`
- Do not run destructive git commands unless explicitly requested.

## Project conventions
- Prefer `rg` for searching.
- Do not include local-only files in commits unless explicitly requested:
  - `.env`
  - local data folders/files
  - machine-specific artifacts
