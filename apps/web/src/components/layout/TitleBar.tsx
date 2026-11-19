import { hostBridge } from "../../lib/hostBridge";
import "./layout.css";

/**
 * The Mac app's draggable window strip.
 *
 * The window is frameless so the app's own header can sit at the very top, but
 * that leaves macOS's close/minimise/zoom buttons floating over whatever is
 * underneath — and leaves no chrome to grab the window by. This strip reserves
 * a band of empty, draggable space above the header for the traffic lights to
 * live in.
 *
 * It renders nothing in a browser tab, where the browser supplies its own
 * chrome and `-webkit-app-region` means nothing.
 */
export function TitleBar() {
  if (!hostBridge()) return null;
  return <div className="titlebar" role="presentation" aria-hidden="true" />;
}
