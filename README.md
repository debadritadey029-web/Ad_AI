# AdVantage AI

AdVantage AI is an enterprise advertising operations platform for managing campaigns, creatives, leads, analytics, financial approvals, provider connections, and AI-assisted marketing workflows from one application.

The application combines a React 19/Vite frontend with a TypeScript Express server. Application state is persisted locally and can be synchronized to Supabase PostgreSQL for hosted deployments.

## Features

- Multi-tenant organization and campaign management
- Role-based access control (RBAC)
- Campaign budgets with currency-aware minor-unit arithmetic
- Four-eyes approval workflow for budget changes
- Emergency stop for campaign and provider write operations
- AI Advertising Copilot powered by Google Gemini
- Creative Studio with provider-format and brand-safety validation
- Lead and messaging management
- Marketing analytics including ROAS, CTR, CPC, and CPA
- Cryptographically chained audit logs
- Supabase database synchronization
- Vercel deployment and GitHub Actions CI/CD

## Technology

- React 19
- Vite 8
- TypeScript
- Express
- Tailwind CSS 4
- Supabase (`@supabase/supabase-js`)
- Google Gemini (`@google/genai`)
- Bun for dependency installation and CI
- Node.js 22+

## Project structure

```text
.
├── api/                    # Vercel serverless entry point
├── docs/                   # Architecture, security, testing, and deployment guides
├── src/
│   ├── components/         # React UI components
│   ├── context/            # Application state/context
│   ├── lib/                # Browser-side integrations
│   └── server/             # API routes, services, database, and tests
├── supabase/schema.sql     # Supabase database migration/schema
├── server.ts               # Local Express + Vite server entry point
├── vite.config.ts          # Vite configuration
└── .github/workflows/ci.yml
```

## Prerequisites

- Node.js 22 or newer
- Bun
- A Supabase project for hosted persistence
- A Google Gemini API key for AI Copilot features

Install Bun if it is not already available:

```bash
npm install --global bun
```

## Local setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/debadritadey029-web/Ad_AI.git
cd Ad_AI
bun install --frozen-lockfile
```

Create a local environment file:

```bash
copy .env.example .env
```

On macOS/Linux, use:

```bash
cp .env.example .env
```

Update `.env` with your local values, then start the application:

```bash
bun run dev
```

The application is available at `http://localhost:3000`.

## Environment variables

### Required for the full application

| Variable | Used by | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | Server | Google Gemini API key for AI Copilot and AI generation |
| `SUPABASE_URL` | Server | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | Private server-side Supabase key for persistence |
| `VITE_SUPABASE_URL` | Browser | Supabase project URL exposed to the Vite client |
| `VITE_SUPABASE_ANON_KEY` | Browser | Public Supabase anon/publishable key |

### Optional configuration

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `PORT` | `3000` | HTTP server port |
| `APP_URL` | — | Public application URL for redirects and webhooks |
| `DATABASE_URL` | — | PostgreSQL connection string for the optional PostgreSQL adapter |
| `SESSION_SECRET` | — | Secret used for session-related cryptographic operations |
| `DISABLE_RATE_LIMIT` | `false` | Disables rate limiting for controlled tests only |
| `META_ADS_ENV` | `SANDBOX` | Meta Ads provider environment |
| `GOOGLE_ADS_ENV` | `SANDBOX` | Google Ads provider environment |
| `TIKTOK_ADS_ENV` | `SANDBOX` | TikTok Ads provider environment |
| `LINKEDIN_ADS_ENV` | `SANDBOX` | LinkedIn Ads provider environment |

The `VITE_` prefix is required for variables used by the browser bundle. Never expose `SUPABASE_SERVICE_ROLE_KEY` or other private secrets through a `VITE_` variable. Do not commit `.env`; use [.env.example](./.env.example) as the template.

## Supabase setup

1. Create a project in Supabase.
2. Open the Supabase SQL Editor.
3. Run the complete migration in [supabase/schema.sql](./supabase/schema.sql).
4. Add the Supabase URL and keys to `.env`.
5. Restart the development server.

The server uses `SUPABASE_SERVICE_ROLE_KEY` for protected server-side snapshot persistence. The frontend uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for browser authentication and client-side Supabase operations.

## Available commands

```bash
bun run dev       # Start the Express/Vite development server
bun run build     # Create the production frontend bundle
bun run start     # Start the application server
bun run preview   # Preview the Vite production bundle
bun run lint      # TypeScript typecheck
bun test          # Run the automated test suite
```

The test suite covers authentication, RBAC, tenant isolation, financial safety, audit-chain verification, and persistence behavior.

## API

The Express API is mounted under `/api`. Important endpoints include:

```text
GET  /api/health
GET  /api/health/ready
GET  /api/campaigns
GET  /api/analytics
GET  /api/providers
GET  /api/creatives
GET  /api/leads
GET  /api/audit
POST /api/copilot/query
POST /api/finance/proposals
POST /api/finance/emergency-stop
```

The complete route implementation is in [src/server/routes.ts](./src/server/routes.ts).

## CI/CD

GitHub Actions is configured in [.github/workflows/ci.yml](./.github/workflows/ci.yml).

Pushes and pull requests targeting `main`, `master`, and `20_10_dev` run:

1. Dependency installation with the committed `bun.lock`
2. TypeScript checking
3. Automated tests
4. Production build

Deployment to Vercel is restricted to `main` and `master`. To enable the deployment job, configure these GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

For direct Vercel deployment, see [docs/VERCEL_SUPABASE_GUIDE.md](./docs/VERCEL_SUPABASE_GUIDE.md).

## Security notes

- Keep `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, database passwords, and `SESSION_SECRET` private.
- Use sandbox environments for advertising provider integrations during development.
- Rotate any credential that has been accidentally committed or shared.
- Review [docs/SECURITY.md](./docs/SECURITY.md) before enabling production provider access.

## Additional documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Testing](./docs/TESTING.md)
- [Security](./docs/SECURITY.md)
- [Vercel and Supabase deployment](./docs/VERCEL_SUPABASE_GUIDE.md)

## License

This project includes source files marked with the Apache License 2.0 header. Review the repository licensing requirements before distributing the application.
