import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiProxy = {
  target: "http://localhost:3000",
  bypass(req: { headers: { accept?: string } }) {
    if (req.headers.accept?.includes("text/html")) {
      return "/index.html";
    }
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/auth": apiProxy,
      "/campaigns": apiProxy,
      "/donations": apiProxy,
      "/evidence": apiProxy,
      "/evidence-files": apiProxy,
      "/ledger": apiProxy,
      "/milestones": apiProxy,
      "/organizations": apiProxy,
      "/dashboard": apiProxy,
      "/routing": apiProxy,
      "/payouts": apiProxy,
    },
  },
});
