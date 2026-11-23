import { Component, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import { useApi } from "./api.js";
import { Pill } from "./components.jsx";
import { useLiveSummaries } from "./live.js";
import { Company, Overview, Summary } from "./pages.jsx";
import "./styles.css";

class ErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="shell">
          <h1>Page unavailable</h1>
          <button onClick={() => location.reload()}>Reload page</button>
        </main>
      );
    return this.props.children;
  }
}

function DetailRoute({ view: View, live }) {
  const { id } = useParams();
  return <View key={id} live={live} />;
}

function App() {
  const live = useLiveSummaries();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Source status can change between publications, including while the socket is disconnected.
    const timer = setInterval(() => setTick((value) => value + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  const status = useApi(live.ready ? "/status" : null, tick + live.revision);
  const mode = status.data?.data_mode;
  return (
    <>
      <a className="skip" href="#main-content">
        Skip to content
      </a>
      <header className="top">
        <div className="shell top-inner">
          <Link className="brand" to="/">
            <span className="brand-icon" aria-hidden="true">
              F
            </span>{" "}
            Finosauras
          </Link>
          <nav aria-label="Main">
            <Link to="/">Watchlist</Link>
          </nav>
          <Pill tone={mode === "fixture" ? "demo" : "neutral"}>
            {mode === "fixture"
              ? "Synthetic demo"
              : mode === "authorized-direct"
                ? "Authorized direct"
                : mode === "licensed-feed"
                  ? "Licensed feed"
                  : "Checking data mode"}
          </Pill>
        </div>
      </header>
      <main className="shell main" id="main-content">
        {mode === "fixture" && (
          <aside className="notice demo">
            Exchange polling is off in demo mode. The demo watcher checks
            bundled fictional transcripts.
          </aside>
        )}
        {mode && mode !== "fixture" && !status.data.scheduler_running && (
          <aside className="notice alert">
            {status.data.scheduler_enabled
              ? "Live watching is currently inactive. Review source health for access and configuration status."
              : "Live exchange polling is off. An approved NSE, BSE, or licensed feed is required."}
          </aside>
        )}
        {live.phase === "offline" && (
          <p className="notice alert" role="status">
            Summary updates disconnected. Reconnecting automatically.
          </p>
        )}
        {live.warning && (
          <p className="notice alert" role="status">
            {live.warning}
          </p>
        )}
        <Routes>
          <Route index element={<Overview live={live} status={status} />} />
          <Route
            path="/companies/:id"
            element={<DetailRoute view={Company} live={live} />}
          />
          <Route
            path="/summaries/:id"
            element={<DetailRoute view={Summary} live={live} />}
          />
          <Route
            path="*"
            element={
              <div className="panel empty">
                <h1>Page unavailable</h1>
                <Link to="/">Back to watchlist</Link>
              </div>
            }
          />
        </Routes>
      </main>
      <footer className="shell footer">
        Financial quarters use the Indian fiscal year when verified. Display
        times are in IST.
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </ErrorBoundary>,
);
