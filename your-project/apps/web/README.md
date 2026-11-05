# ImpactLedger web app

The React + TypeScript frontend is built with Vite and lives in this workspace.

From `your-project`, start the API in one terminal and the frontend in another:

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
