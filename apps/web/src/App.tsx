import type { ReactNode } from "react";
import {
  BrowserRouter,
  HashRouter,
  Routes,
  Route,
  useLocation,
} from "react-router-dom";
import { Header } from "./components/layout/Header";
import { TitleBar } from "./components/layout/TitleBar";
import { ToastProvider, ToastHost } from "./components/ui/Toast";
import { ConfirmProvider } from "./components/ui/ConfirmDialog";
import { ErrorBoundary, ErrorPanel } from "./components/ui/ErrorBoundary";
import { AppStoreProvider, type PlannerRuntime } from "@planner/client-runtime";
import { ProjectsDashboard } from "./routes/ProjectsDashboard";
import { ProjectDetail } from "./routes/ProjectDetail";
import { TeamPage } from "./routes/TeamPage";
import { TrackingPage } from "./routes/TrackingPage";
import { TrackerDetail } from "./routes/TrackerDetail";
import { McpBridge } from "./mcp/McpBridge";

/**
 * The packaged Mac app is loaded from disk over `file://`, which has no History
 * API for BrowserRouter to push into. Served over http (dev server, browser,
 * any future hosting) we keep real URLs.
 */
const Router =
  typeof window !== "undefined" && window.location.protocol === "file:"
    ? HashRouter
    : BrowserRouter;

/** Keyed on the path, so navigating away from a crashed page recovers. */
function PageBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary
      key={pathname}
      fallback={(error) => (
        <main className="page">
          <ErrorPanel title="This page couldn't be shown" error={error}>
            <p className="muted">
              Go back to another tab, or reload the window to try again.
            </p>
          </ErrorPanel>
        </main>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

export default function App({ runtime }: { runtime: PlannerRuntime }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider runtime={runtime}>
          <Router>
            <TitleBar />
            <Header />
            {/* AI clients' tool calls, in the Mac app only. Inside the router
                so a tool can open a page. */}
            <McpBridge />
            <PageBoundary>
              <Routes>
                <Route path="/" element={<ProjectsDashboard />} />
                <Route path="/project/:id" element={<ProjectDetail />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/tracking" element={<TrackingPage />} />
                <Route path="/tracking/:id" element={<TrackerDetail />} />
              </Routes>
            </PageBoundary>
          </Router>
          <ToastHost />
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
