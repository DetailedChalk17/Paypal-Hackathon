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

To use the real API instead of the mock service worker, set
`VITE_API_MODE=real` in the frontend environment and configure the API
environment and database. Start the API and frontend in separate terminals:

```sh
npm run dev --workspace @your-project/api
npm run dev:web
```

The Vite development server proxies API requests to `http://localhost:3000`.
Set `FRONTEND_URL` in the API environment to the frontend origin when using a
different host or port; PayPal approval and cancellation return to that origin.
The default is `http://localhost:5173`.

Build and type-check the frontend with `npm run build:web` and
`npm run typecheck:web`.
