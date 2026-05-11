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
