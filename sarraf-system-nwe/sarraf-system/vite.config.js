import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/src/components/operations/")) return "operations-ui";
          if (id.includes("/src/components/receipts/")) return "receipts-ui";
          if (id.includes("/src/components/portal/")) return "portal-ui";
          if (id.includes("/src/components/market/")) return "market-ui";
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@supabase") || id.includes("iceberg-js")) return "supabase-vendor";
          if (id.includes("lucide-react")) return "icons-vendor";
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor";
          return "vendor";
        },
      },
    },
  },
});
