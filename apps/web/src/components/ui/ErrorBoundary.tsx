import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** What to show instead of the crashed subtree. */
  fallback: (error: Error) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Contains a render crash to the part of the page that crashed.
 *
 * Without one, React unmounts the whole tree on an uncaught render error and
 * the user is left with a blank window and nothing to report. Give it a `key`
 * that changes when the user moves on (e.g. the route) to recover.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.error) return this.props.fallback(this.state.error);
    return this.props.children;
  }
}

/** The fallback most places want: what broke, and the words to report it. */
export function ErrorPanel({
  title,
  error,
  children,
}: {
  title: string;
  error: Error;
  children?: ReactNode;
}) {
  return (
    <div className="error-panel" role="alert">
      <h2>{title}</h2>
      <p>Planner hit an error it didn't expect. Your data is safe.</p>
      <pre className="error-detail">{error.message}</pre>
      {children}
    </div>
  );
}
