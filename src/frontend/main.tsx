/// <reference path="./vite-env.d.ts" />
import React from "react";
import { createRoot } from "react-dom/client";
import { RegistryProvider } from "@effect/atom-react";
import { App } from "./App.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <RegistryProvider>
        <App />
      </RegistryProvider>
    </React.StrictMode>,
  );
}
