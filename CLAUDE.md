# Claude Code Entry Rules

Claude Code must follow the project collaboration rules in `AGENTS.md`.

Before editing:

1. Read `AGENTS.md`.
2. Read `AGENT_COLLAB_LOG.md`.
3. If another agent has an active `In Progress` entry for the same file or behavior, stop and ask 한이룸님 before editing.
4. Add your own `In Progress` entry before changing files.

After editing:

1. Append a `History` entry with changed files and verification.
2. Include screenshots or URLs for frontend layout work.
3. Record any dev server you leave running.

Important project-specific reminders:

- Keep the product name as `한이룸의 상세페이지 마법사 3.0`.
- Preserve the editor's canonical `460px` canvas coordinate system and `1080px` export width.
- Do not run `pnpm build` while your dev server is running in this folder.
- This folder is currently not a git repository, so use explicit handoff notes instead of branch/commit assumptions.

