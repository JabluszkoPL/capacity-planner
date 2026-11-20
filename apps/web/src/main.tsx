import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createAppRuntime } from "./runtime";
import { applyHostAttributes } from "./lib/hostBridge";
import { applyTheme } from "./lib/theme";
import "./styles/global.css";
import "./components/ui/ui.css";

// Before the first paint, so the window strip is never briefly missing and a
// dark-mode choice never flashes light.
applyHostAttributes();
applyTheme();

const root = createRoot(document.getElementById("root")!);

// The runtime opens the local database before the first render, so the app
// never flashes an empty state over data that is already on the machine.
createAppRuntime().then((runtime) => {
  root.render(
    <StrictMode>
      <App runtime={runtime} />
    </StrictMode>,
  );
});
