import { Link } from "react-router-dom";
import type { ViewDef } from "../../lib/views";
import { viewHref } from "../../lib/views";
import { Icon } from "./Icon";

interface ViewTabsProps<T extends string> {
  /** The page's own path, e.g. `/project/p1`. */
  base: string;
  views: readonly ViewDef<T>[];
  current: T;
  /** Names the navigation landmark, e.g. "Project views". */
  label: string;
}

/**
 * The tab row across the top of a page with several views (a project, a
 * tracker). Real links, so each view has a URL, opens in a new tab and works
 * with the browser's back button; the current one carries
 * `aria-current="page"`.
 */
export function ViewTabs<T extends string>({
  base,
  views,
  current,
  label,
}: ViewTabsProps<T>) {
  const first = views[0]!.id;
  return (
    <nav className="view-tabs" aria-label={label}>
      {views.map((v) => {
        const active = v.id === current;
        return (
          <Link
            key={v.id}
            to={viewHref(base, v.id, first)}
            className={"view-tab" + (active ? " active" : "")}
            aria-current={active ? "page" : undefined}
          >
            <Icon name={v.icon} size={15} />
            <span>{v.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
