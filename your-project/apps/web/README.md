# ImpactLedger web app

The React + TypeScript frontend is built with Vite. Its default API mode is
MSW-backed demo data, so you can run and explore the UI without starting the
API or configuring a database:

```sh
cd your-project
npm run dev:web
```

Open `http://localhost:5173`. Sign in with any of the demo roles to see the
role-specific navigation and workflows. The app includes the campaign
marketplace, campaign details and demo donation flow, organizer studio,
reviewer queue, receipt and trace pages, trust profile, and impact dashboard.

To use the real API instead of the mock service worker, create
`apps/web/.env` from [`apps/web/.env.example`](./.env.example). Set
`VITE_API_MODE=real`. Leave `VITE_API_BASE_URL` empty when the frontend and API
share an origin; for separate services, set it to the API service origin (for
example, your Render API URL). Vite embeds these `VITE_` values when it builds
the frontend, so update the hosting environment and rebuild after adding the
URL. Configure the API environment and database, and set `FRONTEND_URL` on the
API to the frontend origin to allow credentialed browser requests. Start the
API and frontend in separate terminals:

```sh
npm run dev --workspace @your-project/api
npm run dev:web
```

The Vite development server proxies API requests to `http://localhost:3000`.
Set `FRONTEND_URL` in the API environment to the frontend origin; PayPal
approval and cancellation return to that origin. The local default is
`http://localhost:5173`.

Demo walkthrough: sign in as supporter, open a campaign and donate, check the
Impact Receipt and verify its ledger, then follow the trace. Sign in as
organizer to create a campaign and submit evidence; switch to reviewer to
inspect and decide on that evidence. Screen recordings are not included in the
repository.

Build and type-check the frontend with `npm run build:web` and
`npm run typecheck:web`.
