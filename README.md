# ImpactLedger — Generosity, Made Transparent

> **PayPal Hackathon 2026** · Trust-First Giving Platform  
> An end-to-end transparent donation and milestone-disbursement platform featuring **PayPal Sandbox Payments**, **Gemini 2.5 Flash AI** receipt auditing & split-routing, and an immutable **SHA-256 Cryptographic Audit Ledger**.

---

## ⚡ Quickstart Setup (One Unified Flow)

Follow these exact steps from the repository root:

```bash
# 1. Install dependencies
npm install

# 2. Copy environment configuration
cp .env.example .env

# 3. Start PostgreSQL with Docker (or use a free Neon / Supabase database URL)
docker compose up -d

# 4. Deploy database migrations
npm run prisma migrate deploy
# (or: npx prisma migrate deploy)

# 5. Seed demo data (campaigns, organizations, milestones, demo users)
npm run seed

# 6. Start API backend and Web frontend concurrently
npm run dev
```

- **Frontend App**: [http://localhost:5173](http://localhost:5173)
- **Backend API**: [http://localhost:3000](http://localhost:3000)

> [!TIP]
> **Alternative Database (Cloud Postgres)**: If you do not have Docker installed, you can use a free cloud Postgres instance from [Neon](https://neon.tech) or [Supabase](https://supabase.com). Paste your pooled connection string into `DATABASE_URL` in `.env`, then run steps 4, 5, and 6.

---

## 🤖 AI Mode: Mock vs. Live

Judges do not need a Google AI API key to test receipt OCR, vendor matching, trust score explanations, and intelligent split routing.

### Mock Mode (`AI_MODE=mock` — Default in `.env.example`)
- By default, `.env.example` sets `AI_MODE=mock`.
- Returns deterministic, instant canned responses for all sample receipts (`scripts/receipts/samples/`), vendor verification, trust scores, and donor natural-language routing.
- Zero external API dependencies, zero cost, and zero rate limits.

### Live Mode (`AI_MODE=live`)
If you wish to test live multimodal inference with Google Gemini 2.5 Flash:
1. Obtain an API key from [Google AI Studio](https://aistudio.google.com/).
2. In `.env`, update:
   ```env
   AI_MODE=live
   AI_API_KEY="your-google-ai-studio-api-key"
   AI_PROVIDER=gemini
   AI_MODEL=gemini-2.5-flash
   ```
3. Restart `npm run dev`.

---

## 💳 PayPal Sandbox Setup for Judges

ImpactLedger uses PayPal REST APIs (v2 Checkout Orders, Captures, and Webhooks).

### 1. Sandbox App Credentials
1. Log into the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox).
2. Under **REST API apps**, create a new sandbox app or select your default app.
3. Copy the **Client ID** and **Secret** into your `.env`:
   ```env
   PAYPAL_ENVIRONMENT=sandbox
   PAYPAL_ENV=sandbox
   PAYPAL_CLIENT_ID="your_sandbox_client_id"
   PAYPAL_CLIENT_SECRET="your_sandbox_client_secret"
   ```
> [!IMPORTANT]
> Sandbox credentials are test-only and safe for hackathon evaluation. Real `.env` files are git-ignored and never committed to version control.

### 2. Sandbox Buyer Account for Testing Checkout
To complete the PayPal checkout flow without real money:
- Under **Testing Tools > Sandbox Accounts** in the PayPal Developer Dashboard, select or create a **Personal (Buyer)** account.
- **Sample Test Buyer Credentials**:
  - **Email**: `sb-buyer@business.example.com` (or your sandbox personal email)
  - **Password**: *(The password configured in your PayPal sandbox account)*
- When clicking **"Donate with PayPal"**, log in with your sandbox personal buyer credentials and click **Complete Purchase**.

---

## 🔒 Immediate Ledger Recording (Works Without Webhooks)

> [!NOTE]
> Local development environments (`localhost`) cannot receive asynchronous PayPal webhooks directly from PayPal servers without a public ingress tunnel.

**ImpactLedger guarantees ledger integrity without requiring webhooks:**
- When the donor approves payment on PayPal, PayPal redirects the browser back to:
  `http://localhost:5173/paypal/return?donationId=...&token=...`
- The client initiates `POST /donations/:donationId/capture`.
- The server captures the order directly with PayPal API (`captureOrder`) and atomically executes:
  1. Marks the donation as `completed`.
  2. Updates the campaign funds raised.
  3. Appends an immutable `DONATION_COMPLETED` block to the **SHA-256 cryptographic hash-chained audit ledger** within a single Prisma transaction.
- **Your donation is recorded to the cryptographic ledger immediately upon checkout completion**, even with no webhook URL configured!

### Optional: Testing Webhooks with a Tunnel
If you want to test live PayPal webhook events:
```bash
# In a separate terminal, expose port 3000:
npx localtunnel --port 3000
# or: ngrok http 3000
```
1. In your PayPal Developer Dashboard app settings, click **Add Webhook**.
2. URL: `https://<your-subdomain>.localtunnel.me/donations/webhooks/paypal`
3. Event: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`.
4. Copy the Webhook ID and put it in `.env`: `PAYPAL_WEBHOOK_ID=your_id`.

---

## 📋 Devpost Testing Instructions (Copy & Paste)

Copy the text below directly into Devpost's **Testing Instructions** field:

```markdown
### How to Test ImpactLedger

1. Clone repository & install dependencies:
   git clone <repo-url>
   npm install

2. Copy environment file:
   cp .env.example .env

3. Start database:
   docker compose up -d
   # (Or paste your free Neon/Supabase Postgres connection string in .env)

4. Run migrations & demo seed:
   npm run prisma migrate deploy
   npm run seed

5. Start app:
   npm run dev
   Open http://localhost:5173

6. Test Scenarios:
   - Supporter Experience: Browse campaigns, try AI natural-language split routing, and donate using PayPal Sandbox.
   - Immediate Ledger Audit: View /ledger or check the cryptographic proof receipt for any completed gift.
   - Organizer Experience: Switch demo role to "Organizer" to upload expense evidence and submit receipts.
   - AI Receipt Verification: AI OCR transcribes vendor, total, and verifies milestone relevance (works in AI_MODE=mock out of the box, or set AI_API_KEY for live Gemini 2.5 Flash).
   - Reviewer Experience: Switch demo role to "Reviewer" to audit flagged expenses and approve milestone payouts.
```

---

## 🧪 Testing & Verification

```bash
# Run unit tests across all packages (AI, PayPal, API, Web)
npm run typecheck
npm --workspace=@your-project/ai test
```

---

## 🏛 Architecture & Tech Stack

- **Monorepo**: Turborepo / npm workspaces
- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, TanStack Query
- **Backend API**: Node.js, Express, TypeScript, Helmet, Prisma ORM
- **Database**: PostgreSQL 16
- **Payments**: PayPal REST API (v2 Orders, Captures, Webhooks)
- **AI Engine**: Google Gemini 2.5 Flash SDK (`@google/genai`) with fallback MockProvider
- **Integrity**: SHA-256 Merkle-style cryptographic audit ledger

