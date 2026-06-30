# PDP Maker 3.0 Agent Collaboration Rules

Scope: `/Users/irun_hahn/Documents/Codex/pdp-maker-30`

Product name: `한이룸의 상세페이지 마법사 3.0`

Canonical 3.0 source root: `/Users/irun_hahn/Documents/Codex/pdp-maker-30`

This file is the shared rulebook for Codex, Claude Code, and any other coding agent working in this folder. Read this before editing.

## 1. Collaboration Contract

- Check `AGENT_COLLAB_LOG.md` before touching files.
- Add an `In Progress` entry before editing. Include agent name, timestamp, objective, files or areas you plan to touch, and planned verification.
- Only one agent may own a file or feature area at a time. If another active entry names the same file or area, stop and ask 한이룸님 before editing.
- After finishing, append a `History` entry with changed files, verification commands, screenshots or URLs, remaining risks, and handoff notes.
- Never erase or rewrite another agent's log entry. Append a correction instead.
- If a patch to the log fails, assume concurrent edits first. Re-read the file, then retry with a smaller append-only patch.
- This folder is currently not a git repository. Do not rely on commit history, branches, or `git checkout` for recovery unless a repo is initialized later. Use explicit file lists and handoff notes.

## 2. Ownership Map

- Main upload/setup flow: `app/pdp-maker/PdpMakerClient.tsx`
- Editor/canvas/export flow: `app/pdp-maker/PdpEditor.tsx`
- Visual system and responsive layout: `app/pdp-maker/pdp-maker.module.css`, `app/globals.css`
- Settings sheet and API-key UX: `app/pdp-maker/PdpSettingsSheet.tsx`, `app/pdp-maker/pdp-settings.ts`
- Draft persistence: `app/pdp-maker/pdp-drafts.ts`
- Client utilities: `app/pdp-maker/pdp-utils.ts`
- Server/API orchestration: `lib/pdp-server/*`, `app/api/pdp/*` if added later
- Shared contracts and types: `lib/shared/*`
- Evidence artifacts: `output/playwright/*`

When a change crosses two or more areas, log the full surface before editing.

## 3. High-Risk Rules

- Do not change the app name back to 2.5. The visible product name and metadata should stay `한이룸의 상세페이지 마법사 3.0`.
- The editor uses a canonical canvas coordinate width of `460px` and fixed export width of `1080px`. If you change overlay display styles, also check export rendering in `buildExportNode`.
- Drag/resize math must convert between displayed mobile scale and canonical canvas coordinates. Do not store mobile-scaled coordinates in drafts.
- Keep browser storage language honest. API keys may be sent during request processing, but they must not be logged, committed, or stored server-side.
- Drafts live in IndexedDB (`hanirum-pdp-maker`, store `drafts`). Any schema change needs a backward-compatible normalization path.
- Do not run `pnpm build` while your dev server is running in this same folder. Stop your own dev server first, because Next's `.next` output can get out of sync during concurrent dev/build runs.
- Do not kill unknown Node processes. If a port is occupied, use another port and record it in the log.
- Do not delete `.next`, `output/`, `.playwright-mcp/`, or generated screenshots unless the task explicitly requires cleanup and you record why.

## 4. Verification Ladder

Use the smallest verification that proves the change.

- Docs-only or copy-only rule changes: no runtime check required; record that it was docs-only.
- TypeScript or React logic change: run `pnpm typecheck`.
- Production-impacting change: stop your own dev server, then run `pnpm build`.
- Frontend layout change: verify `/pdp-maker` in a browser at desktop and mobile widths. Recommended widths: `1440x1100` and `390x844`.
- Mobile layout change: check `document.documentElement.scrollWidth` and `document.body.scrollWidth`; they should match the viewport width unless horizontal scrolling is intentional.
- Canvas/export change: verify current-section download and ZIP flow where practical; confirm export still uses the fixed `1080px` width.
- API/provider change: test key validation and the affected endpoint. Never print API keys in logs or screenshots.

Preferred evidence path: `output/playwright/`.

## 5. Dev Server Rules

- Default package script uses port `3002`: `pnpm dev`.
- If `3002` is occupied, use another port such as `3003`: `pnpm exec next dev -p 3003`.
- Before starting a server, check whether an existing server is already running if port choice matters.
- Before running `pnpm build`, stop the dev server you started in this workspace.
- If you leave a dev server running for 한이룸님, mention the exact URL and port in the final answer and in `AGENT_COLLAB_LOG.md`.

## 6. Handoff Format

Use this compact format in `AGENT_COLLAB_LOG.md`.

```md
- 2026-06-28 HH:MM KST | Agent=Codex | Status=In progress
  Objective:
  Files/areas:
  Planned verification:
  Notes:
```

```md
- 2026-06-28 HH:MM KST | Agent=Codex | Status=Done
  Objective:
  Changed files:
  Verification:
  Screenshots/URLs:
  Handoff notes:
  Remaining risks:
```

## 7. Conflict Protocol

If conflict is possible:

1. Stop before editing.
2. Re-read `AGENT_COLLAB_LOG.md`.
3. Identify the overlapping files or behavior.
4. Ask 한이룸님 which agent should own the surface.
5. Continue only after ownership is clear.
