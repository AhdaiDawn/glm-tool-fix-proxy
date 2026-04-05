# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Node.js ESM proxy. Keep changes local and easy to trace.

- `server.mjs`: HTTP proxy entrypoint and SSE response handling.
- `repair.mjs`: `tool_calls[].function.arguments` stream repair logic.
- `test/repair.test.mjs`: regression tests for repair behavior.
- `README.md`: setup, usage, and manual verification examples.
- `justfile`: common development and manual check commands.

## Build, Test, and Development Commands
Use Node.js 20+.

- `npm test`: run the full test suite with `node --test`.
- `just test`: same as `npm test`.
- `just check`: syntax-check `server.mjs` and `repair.mjs`.
- `npm start`: start the proxy with default environment values.
- `just start`: start the proxy with `PORT`, `HOST`, and `UPSTREAM_BASE_URL` from the `justfile`.
- `just curl-chat`: send a non-streaming request to the local proxy.
- `just curl-stream`: send a streaming tool-call request that exercises the repair path.

## Coding Style & Naming Conventions
Match the existing code style:

- Use ES modules with `.mjs` files and named exports where useful.
- Use 2-space indentation, double quotes, and semicolons.
- Prefer small helper functions over large inline blocks.
- Use clear camelCase names for functions and variables, and PascalCase for classes such as `ToolCallArgumentRepair`.
- Keep new files near the top-level module they support unless a new subdirectory is justified.

No formatter or linter is configured here. Keep style changes minimal and consistent with nearby code.

## Testing Guidelines
Write tests with Node's built-in `node:test` and `node:assert/strict`.

- Put tests under `test/`.
- Name files `*.test.mjs`.
- Add regression coverage for each streaming edge case you fix.
- Run `npm test` and `just check` before opening a pull request.

## Commit & Pull Request Guidelines
This checkout does not include `.git`, so commit conventions cannot be read from local history. Use short, imperative commit subjects such as `fix duplicated final tool-call chunk`.

For pull requests, include:

- a clear description of the broken request or stream shape,
- the code path changed,
- test coverage added or updated,
- sample `just curl-stream` output when behavior changes.

## Security & Configuration Tips
Do not commit real upstream API keys or private endpoint details. Configure `PORT`, `HOST`, `UPSTREAM_BASE_URL`, and `UPSTREAM_API_KEY` through the environment when testing locally.
