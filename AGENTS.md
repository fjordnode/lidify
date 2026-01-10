# Repository Guidelines

## Project Structure & Module Organization
- `backend/` contains the Express + Prisma API (`backend/src`) and database scripts.
- `frontend/` is the Next.js app (App Router) with UI in `frontend/app`, components in `frontend/components`, and feature modules in `frontend/features`.
- `services/` holds sidecars like the audio analyzer (`services/audio-analyzer`).
- `docs/` contains architecture notes, handoff docs, and scripts; `assets/` hosts static images.
- Compose files live at the repo root (`docker-compose*.yml`) alongside the `Dockerfile`.

## Build, Test, and Development Commands
Backend (from `backend/`):
- `npm run dev` - run API with hot reload via `tsx`.
- `npm run build` - compile TypeScript to `dist/`.
- `npm run test:smoke` - run the backend smoke test script.
- `npm run db:migrate` - apply Prisma migrations.

Frontend (from `frontend/`):
- `npm run dev` - run Next.js dev server on port 3030.
- `npm run build` - production build.
- `npm run lint` - ESLint checks.
- `npm run test:e2e` - Playwright end-to-end tests.

## Coding Style & Naming Conventions
- TypeScript across frontend and backend; keep files in feature folders (e.g., `frontend/features/artist/...`).
- Follow existing naming patterns like `routes/*.ts`, `services/*.ts`, and React components in `PascalCase`.
- No explicit formatter config in repo; rely on ESLint (frontend) and TypeScript compiler for safety.

## Testing Guidelines
- E2E tests live in `frontend/tests/e2e` (Playwright, `*.spec.ts`).
- Backend tests are minimal; `backend/src/tests/*.test.ts` use `tsx` to run.
- Prefer adding coverage for regressions (UI: Playwright; API: smoke or targeted TS tests).

## Commit & Pull Request Guidelines
- Commit history uses short, scoped prefixes (e.g., `feat: ...`, `search: ...`, `covers: ...`).
- Keep commits focused and imperative; one logical change per commit when possible.
- PRs should describe the user impact, list key files touched, and include logs or screenshots when relevant (see README support guidance for `docker compose logs`).

## Security & Configuration Tips
- Use `.env.example` as the baseline; avoid committing secrets.
- Services run via Docker Compose; update `docker-compose*.yml` consistently when adding ports or services.
