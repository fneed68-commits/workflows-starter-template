import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Vitest config for Cloudflare Workers tests.
 *
 * `miniflare.bindings` injects env vars for tests. These are separate
 * from `.dev.vars` (which is only used by `wrangler dev` and `wrangler
 * deploy`) so tests never depend on local secrets.
 */
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
            },
        },
    },
});
