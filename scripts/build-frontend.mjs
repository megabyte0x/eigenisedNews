import { context } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function main() {
  const outdirArg = process.argv[2];
  if (!outdirArg) {
    throw new Error("outdir_required");
  }

  const watch = process.argv.includes("--watch");
  const outfile = resolve(process.cwd(), outdirArg, "app.js");
  await mkdir(dirname(outfile), { recursive: true });

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
