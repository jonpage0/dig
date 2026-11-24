import React from "react";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { AppShell } from "./components/AppShell.tsx";
import { AboutPage } from "./pages/AboutPage.tsx";
import { DigDetailPage } from "./pages/DigDetailPage.tsx";
import { LibraryPage } from "./pages/LibraryPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SetupWizardPage } from "./pages/SetupWizardPage.tsx";
import { SourcesPage } from "./pages/SourcesPage.tsx";
import { TrailPage } from "./pages/TrailPage.tsx";

const rootRoute = createRootRoute({
  component: AppShell,
});

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LibraryPage,
});

const digDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dig/$project/$dig",
  validateSearch: (search: Record<string, unknown>): { file?: string } => ({
    ...(typeof search.file === "string" && search.file ? { file: search.file } : {}),
  }),
  component: DigDetailPage,
});

const trailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trail",
  validateSearch: (search: Record<string, unknown>): { dig?: string } => ({
    ...(typeof search.dig === "string" && search.dig ? { dig: search.dig } : {}),
  }),
  component: TrailPage,
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: SourcesPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  validateSearch: (search: Record<string, unknown>): { step?: number } => {
    const raw = typeof search.step === "number" ? search.step : Number(search.step);
    return Number.isInteger(raw) && raw >= 1 && raw <= 4 ? { step: raw } : {};
  },
  component: SetupWizardPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: AboutPage,
});

const fallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  component: LibraryPage,
});

const routeTree = rootRoute.addChildren([
  libraryRoute,
  digDetailRoute,
  trailRoute,
  sourcesRoute,
  setupRoute,
  settingsRoute,
  aboutRoute,
  fallbackRoute,
]);

export const router = createRouter({
  routeTree,
  history: createBrowserHistory(),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <RouterProvider router={router} />;
}
