import { context } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function renderFrontendShell(runtimeConfig = {}) {
  const runtimeConfigJson = JSON.stringify(runtimeConfig).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>The Eigenised Gazette · eigenisedNews research</title>
    <meta
      name="description"
      content="A newspaper-styled research desk for submitting news articles and reading pro/contra EigenCompute analysis."
    />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="application/json" id="frontend-runtime-config">${runtimeConfigJson}</script>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;
}

async function writeFrontendShell(outdir) {
  const apiBaseUrl = process.env.FRONTEND_API_BASE_URL?.trim();
  const runtimeConfig = apiBaseUrl ? { apiBaseUrl } : {};
  await writeFile(resolve(process.cwd(), outdir, "index.html"), renderFrontendShell(runtimeConfig));
}

async function main() {
  const outdirArg = process.argv[2];
  if (!outdirArg) {
    throw new Error("outdir_required");
  }

  const watch = process.argv.includes("--watch");
  const outfile = resolve(process.cwd(), outdirArg, "app.js");
  await mkdir(dirname(outfile), { recursive: true });
  await writeFrontendShell(outdirArg);

  const buildContext = await context({
    entryPoints: ["src/frontend/main.tsx"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    sourcemap: watch,
    logLevel: "info",
    loader: { ".css": "css" },
  });

  if (watch) {
    await buildContext.watch();
    await new Promise(() => {});
  } else {
    await buildContext.rebuild();
    await buildContext.dispose();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
