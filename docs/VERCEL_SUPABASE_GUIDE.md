# Vercel Deployment & Supabase Cloud Integration Guide

This guide details how to host **AdVantage AI** on **Vercel** with **Supabase Database & Authentication** on the **Free Tier**, using **Continuous Integration & Deployment (CI/CD)** without Docker or containerization.

---

## 1. Supabase Database & Auth Setup (Free Tier)

### Step 1: Create a Free Project in Supabase
1. Go to [supabase.com](https://supabase.com) and create an account.
2. Click **New project** $\rightarrow$ select your preferred free-tier region and choose a secure database password (save this password).
3. Once initialized, navigate to **Project Settings** $\rightarrow$ **API**. Note down:
   - **Project URL:** `https://<project-ref>.supabase.co`
   - **Anon Public Key:** `eyJhbGciOi...`
   - **Service Role Secret Key:** `eyJhbGciOi...`

### Step 2: One-Click SQL Schema Migration
1. In your Supabase Dashboard, open the **SQL Editor** tab from the left navigation.
2. Click **New query**.
3. Open the file `supabase/schema.sql` from this repository, copy its entire contents, paste them into the SQL editor, and click **Run**.
4. This script automatically:
   - Creates all tables: `organizations`, `users` (with 2FA & phone support), `memberships`, `otp_codes`, `campaigns`, `budget_proposals`, `creatives`, `leads`, and `audit_logs`.
   - Enables **Row Level Security (RLS)**.
   - Creates indexes for high-speed email and phone number lookups.
   - Populates initial enterprise demo organizations and users.

### Step 3: Enable Email & Phone Auth in Supabase
1. In Supabase Dashboard, go to **Authentication** $\rightarrow$ **Providers**.
2. **Email Provider:** Ensure Email is enabled. For OTP codes, ensure "Confirm email" or "Enable email OTP" is active.
3. **Phone Provider (Optional for live SMS):**
   - Enable Phone. For free testing, Supabase provides test phone numbers and verification codes under Authentication $\rightarrow$ Phone (e.g. `+1 555-234-5678` with code `123456`).
   - For live SMS in production, connect Twilio or MessageBird credentials.
   *(Note: AdVantage AI also contains a built-in zero-cost OTP engine with instant test-code auto-fill, so you can test complete 2-step verification immediately without any paid SMS gateway).*

---

## 2. Vercel Hosting (Zero Docker / Native Serverless)

AdVantage AI is configured for Vercel using standard web specifications and Vercel's native Vite preset.

### Key Architecture Configuration:
* **`vercel.json`**: Configures Vite framework detection, output directory (`dist`), and routes API requests (`/api/*`) directly to Vercel Serverless Functions (`/api/index.ts`).
* **`api/index.ts`**: The serverless handler powered by Express, providing all enterprise RBAC, 2FA, OTP verification, and marketing API routes.
* **Frontend**: Compiled into high-performance static assets served worldwide via Vercel's Edge CDN.

### Step-by-Step Vercel Deployment:

#### Option A: Direct GitHub Integration (Recommended, 1-Click)
1. Push your repository to GitHub.
2. Log into [vercel.com](https://vercel.com) (Hobby / Free Tier).
3. Click **Add New...** $\rightarrow$ **Project**.
4. Import your GitHub repository `ad_management`.
5. Vercel will automatically detect:
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
6. Under **Environment Variables**, add the following:

| Variable | Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Production environment flag |
| `SESSION_SECRET` | *(Random 32+ char string)* | Cryptographic session signing |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Your Supabase Project URL |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` | Client-accessible Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | *(Your Supabase anon key)* | Client-accessible public key |
| `SUPABASE_SERVICE_ROLE_KEY` | *(Your Supabase service role)* | Backend elevated database access |
| `DATABASE_URL` | `postgresql://postgres...` | Direct connection string with DB password |
| `GEMINI_API_KEY` | *(Your Gemini API Key)* | For AI Copilot & Creative Generation |

7. Click **Deploy**. Vercel will build and assign you a live HTTPS domain (e.g., `https://advantage-ai.vercel.app`).

#### Option B: Automated CI/CD Deployment via GitHub Actions
The repository includes `.github/workflows/ci.yml`. To deploy from GitHub Actions:
1. In Vercel, generate a Personal Access Token (**Account Settings** $\rightarrow$ **Tokens**).
2. In your GitHub repository $\rightarrow$ **Settings** $\rightarrow$ **Secrets and variables** $\rightarrow$ **Actions**, add:
   - `VERCEL_TOKEN`: Your Vercel token
   - `VERCEL_ORG_ID`: Your Vercel team/user ID (found in `.vercel/project.json` or team settings)
   - `VERCEL_PROJECT_ID`: Your Vercel project ID
3. Every push to `main` will automatically run typechecking, all automated tests, compile the bundle, and deploy to Vercel with zero Docker!

---

## 3. Two-Step Authentication & OTP Usage

AdVantage AI provides enterprise 2-Step Login & Multi-Factor Authentication:

1. **Two-Step Email & Phone OTP Login:**
   - Click **2-Step Auth** in the top navigation bar.
   - Choose **Direct OTP (Passwordless)** or **Password + 2-Step OTP**.
   - Select **Email** or **SMS Phone** channel.
   - Enter your email or mobile number with country code.
   - Enter the 6-digit OTP code received.
   - In test/staging environments, the generated test code is displayed in a badge with an **Auto-Fill** button for effortless zero-cost verification.

2. **Security & 2FA Configuration:**
   - In the **Security & 2FA Settings** tab, users can toggle mandatory 2FA on/off.
   - Configure preferred channel: **Email Only**, **Phone/SMS Only**, or **Both (Fallback)**.
   - Update registered mobile phone numbers.

3. **Supabase Cloud Sync Monitor:**
   - In the **Supabase DB Sync** tab, check real-time connection status.
   - Copy the migration schema with 1 click.
