import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createDashboardApi } from "./api.js";
import "./style.css";
const token = window.location.hash.slice(1);
window.history.replaceState(null, "", window.location.pathname);
const root = document.getElementById("root");
if (!root) throw new Error("Missing dashboard root");
createRoot(root).render(
  token ? (
    <App api={createDashboardApi(token)} />
  ) : (
    <main>
      <h1>Ralph dashboard</h1>
      <p>Open the authenticated URL from /ralph-status.</p>
    </main>
  ),
);
