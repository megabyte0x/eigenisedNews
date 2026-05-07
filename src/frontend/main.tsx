import React from "react";
import { createRoot } from "react-dom/client";
import { NewsResearchApp } from "./NewsResearchApp";
import "./styles.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("root_container_missing");
}

createRoot(container).render(
  <React.StrictMode>
    <NewsResearchApp />
  </React.StrictMode>
);
