// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
//
// Cloudflare Workers deployment via @astrojs/cloudflare v13. The app is
// fully client-side after the initial HTML load; the Worker is only the
// hosting target.
export default defineConfig({
  output: "server",
  adapter: cloudflare(),
});
