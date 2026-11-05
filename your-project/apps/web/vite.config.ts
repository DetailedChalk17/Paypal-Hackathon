import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/auth": "http://localhost:3000",
      "/campaigns": "http://localhost:3000",
      "/donations": "http://localhost:3000",
      "/evidence/": "http://localhost:3000",
      "/evidence-files/": "http://localhost:3000",
      "/ledger": "http://localhost:3000",
      "/milestones": "http://localhost:3000",
      "/organizations": "http://localhost:3000",
      "/dashboard": "http://localhost:3000",
      "/routing": "http://localhost:3000",
      "/payouts": "http://localhost:3000",
    },
  },
});
