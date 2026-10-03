import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
    test: {
        poolOptions: {
            workers: {
                wrangler: { configPath: "./wrangler.jsonc" },
                miniflare: {
                    bindings: {
                        API_TOKEN: "test-token-12345",
                        ALLOWED_ORIGINS: "http://localhost:5173",
                    },
                },
                // Disable per-test isolated storage. Our tests use SELF.fetch
                // to hit /api/workflow/start, which spins up a real Workflow
                // and its Durable Object. The DO writes to storage asynchronously
                // via a fire-and-forget notify() call, and the isolated-storage
                // "checkout" step at the end of each test cannot settle that
                // state — it fails with "Isolated storage failed". Running the
                // tests in a shared storage context removes the constraint.
                isolatedStorage: false,
                singleWorker: true,
            },
        },
    },
});
