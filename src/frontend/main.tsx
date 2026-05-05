import React from "react";
import { createRoot } from "react-dom/client";
import { OperatorConsole } from "./OperatorConsole";
import "./styles.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("root_container_missing");
}

createRoot(container).render(
  <React.StrictMode>
    <OperatorConsole />
  </React.StrictMode>
);
