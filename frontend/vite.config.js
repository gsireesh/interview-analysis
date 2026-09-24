import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const page = (name) => fileURLToPath(new URL(`${name}.html`, import.meta.url));

// The URLs the server serves, and the file behind each. One spelling, used by
// both the dev rewrite and the build inputs, so the two cannot drift.
const PAGES = { "/": "library", "/reader": "reader", "/themes": "themes" };

/** Serve /reader in dev at the URL it is served at in production. */
function pageUrls() {
  return {
    name: "subtitle-search:page-urls",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path, query] = req.url.split("?");
        const file = PAGES[path];
        if (file) req.url = `/${file}.html${query ? `?${query}` : ""}`;
        next();
      });
    },
  };
}

const backend = process.env.SUBTITLE_SEARCH_BACKEND ?? "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react(), pageUrls()],
  appType: "mpa",
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Everything the app asks the server for is under /api, including the
      // media at /api/recordings/{id}/parts/{n}/media, which is range-requested.
      //
      // So: one rule, no rewrite, no `configure` hook, no compression, no
      // timeout. Anything that reads or buffers the response body turns a 206
      // into a 200 with no Content-Range, and the player stops being able to
      // seek -- which is the interaction the whole tool is built around. A
      // timeout would cut the open connection of a video that is merely paused.
      "/api": { target: backend, changeOrigin: false },
      // Only while the vanilla pages still exist. Goes with static/.
      "/static": { target: backend, changeOrigin: false },
    },
  },
  build: {
    // Not static/: vite build empties its output directory, and static/ still
    // holds the hand-written app being served. web/ is generated, static/ is
    // written by hand, and both exist until the migration finishes.
    outDir: fileURLToPath(new URL("../subtitle_search/web", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      // Entries are added as each page is ported; until then the server keeps
      // serving the hand-written page from static/, so web/ never holds a
      // half-built one.
      input: { library: page("library"), reader: page("reader") },
    },
  },
});
