// App page loader. Each app page loads this instead of its app modules directly:
//   <script type="module" src="/js/boot.js" data-app="bridge" data-mods="/js/bridge.js"></script>
// When the app is live on the active network (config.js LIVE), its modules load as usual. Before launch the
// page shows the pre-launch panel instead, so no page ever calls a contract that does not exist yet.
import { LIVE } from "./config.js";

const tag = document.querySelector("script[data-app]");
const app = tag?.dataset.app;
const mods = (tag?.dataset.mods || "").split(",").map((m) => m.trim()).filter(Boolean);
if (app && LIVE[app]) {
  for (const m of mods) await import(m);
} else if (app) {
  const { showPrelaunch } = await import("./prelaunch.js");
  showPrelaunch(app);
}
