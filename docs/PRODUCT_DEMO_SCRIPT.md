# AdVantage AI — 2-minute customer demo script

Use this as the narration and recording checklist for the customer-facing Product Demo player. Record against an isolated staging tenant with fictional data only.

## Recording plan

| Time | Screen / action | Suggested narration |
|---|---|---|
| 0:00–0:12 | Open the dashboard and identify the active organization | “AdVantage AI brings campaign planning, creative workflows, financial governance and performance views into one workspace.” |
| 0:12–0:30 | Open Channels and show supported provider catalog / connection status | “Start by selecting the right organization and reviewing the advertising channels configured for your account. Provider connections require authorized access.” |
| 0:30–0:52 | Open Campaigns and show a draft, objective, budget, audience and schedule | “Create a campaign draft, define the objective and budget, then review targeting and schedule before any launch decision.” |
| 0:52–1:10 | Open Creative Studio and show copy / creative review | “Prepare channel-specific assets and review brand suitability. Keep content in draft or review until an authorized person approves it.” |
| 1:10–1:32 | Open Financial Safety and show a proposal / four-eyes review / emergency stop | “Budget changes follow independent review and organization guardrails. The emergency stop blocks internal workflows; provider-side pausing is only available when a verified integration exists.” |
| 1:32–1:50 | Open Analytics and AI Copilot | “Review the performance data available to your workspace and use the AI copilot to help interpret results and identify optimization ideas.” |
| 1:50–2:00 | Open Product Demo and close on product name | “AdVantage AI helps teams work from planning to oversight with explicit human review and financial controls.” |

## Before publishing the recording

- Use an isolated staging organization and clearly fictional campaign names, budgets, creatives, leads and metrics.
- Never show .env files, API keys, session cookies, service-role keys, OAuth tokens, private URLs, customer personal data or real account IDs.
- Do not narrate a feature as live unless it has been tested end-to-end against the real provider in a sandbox.
- Do not imply that a campaign was published or a provider budget changed if only the internal draft was updated.
- Export an MP4 and host it on HTTPS, YouTube or Vimeo. Set the Vercel environment variable VITE_PRODUCT_DEMO_VIDEO_URL to the video URL and redeploy.
