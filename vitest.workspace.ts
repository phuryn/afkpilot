import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "default",
      include: ["test/**/*.test.ts"],
      exclude: ["test/*-supabase.integration.test.ts"],
    },
  },
  {
    test: {
      name: "supabase-live",
      include: ["test/*-supabase.integration.test.ts"],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  },
]);
