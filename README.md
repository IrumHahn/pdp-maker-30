# 한이룸의 상세페이지 마법사 3.0

This is the canonical source folder for PDP Maker 3.0.

- Source root: `/Users/irun_hahn/Documents/Codex/pdp-maker-30`
- Previous mixed folder: `/Users/irun_hahn/Documents/Codex/pdp-maker-25`
- Main route: `/pdp-maker`
- Default dev command: `pnpm dev`
- Verification command: `pnpm typecheck`

Do new 3.0 work here so the older 2.5 naming lane does not overlap with 3.0 development.

## Bug Report Notifications

New reports from the `/pdp-maker` floating bug-report widget are saved to `output/bug-reports/*.jsonl`.
Admin status changes and internal notes are appended to `output/bug-reports/_admin-events.jsonl`, then merged into the admin list at render time.

Optional production notification environment variables:

- `PDP_BUG_REPORT_DISCORD_WEBHOOK_URL`: Discord triage webhook URL.
- `RESEND_API_KEY`: Resend API key for email notifications.
- `PDP_BUG_REPORT_EMAIL_FROM`: Verified sender email address.
- `PDP_BUG_REPORT_NOTIFY_EMAIL_TO`: Operator email recipient. Comma-separated recipients are supported.
- `PDP_MAKER_BASE_URL`: Public app origin used in admin links.
- `PDP_BUG_REPORT_ADMIN_TOKEN`: Optional production token for `/pdp-maker/admin/bug-reports`. Use the admin login form; the token is not kept in page URLs.
- `PDP_BUG_REPORT_REPLY_TO`: Optional reply-to address for customer status-update emails. Falls back to `PDP_BUG_REPORT_NOTIFY_EMAIL_TO`.
