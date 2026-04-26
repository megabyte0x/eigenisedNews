import express, { type Express } from "express";

export function buildApp(): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  buildApp().listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "listening", port }));
  });
}
