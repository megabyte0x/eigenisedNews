export type FrontendRuntimeConfig = {
  apiBaseUrl?: string;
};

export function renderFrontendShell(runtimeConfig: FrontendRuntimeConfig = {}): string {
  const runtimeConfigJson = JSON.stringify(runtimeConfig).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>eigenisedNews operator console</title>
    <meta
      name="description"
      content="Operator console for submitting synthesis requests and inspecting signed consensus manifests."
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
