export function createCameraDiscoveryController({
  button,
  spinner,
  results,
  hostInput,
  portInput,
  api,
  currentContext,
  setEditorMessage,
  createElement = (tag) => document.createElement(tag),
  logWarning = (message) => console.warn(message)
}) {
  let busy = false;
  let sequence = 0;

  function setBusy(value) {
    busy = Boolean(value);
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    spinner.classList.toggle("active", busy);
  }

  function clearResults(message = "") {
    results.replaceChildren();
    if (!message) return;
    const empty = createElement("p");
    empty.className = "discovery-empty";
    empty.textContent = message;
    results.append(empty);
  }

  function cancel() {
    sequence += 1;
    setBusy(false);
  }

  function isCurrent(token, context) {
    return token === sequence && currentContext() === context;
  }

  async function discover() {
    if (busy) return;
    const token = ++sequence;
    const context = currentContext();
    if (!context) return;
    try {
      setBusy(true);
      clearResults("Discovering available cameras…");
      const payload = await api("/api/cameras/_actions/discover", { method: "POST", body: "{}" });
      if (!isCurrent(token, context)) return;
      const candidates = payload.cameras || [];
      results.replaceChildren();
      if (!candidates.length) {
        clearResults("No available cameras were found. You can enter Host / IP manually.");
        return;
      }
      for (const candidate of candidates) {
        const row = createElement("button");
        row.type = "button";
        row.className = "discovery-candidate";
        const host = createElement("strong");
        host.textContent = candidate.host;
        const choose = createElement("span");
        choose.textContent = "Select";
        row.append(host, choose);
        row.addEventListener("click", () => {
          hostInput.value = candidate.host;
          portInput.value = "";
          setEditorMessage("Enter the camera Username and Password.");
        });
        results.append(row);
      }
    } catch (error) {
      if (!isCurrent(token, context)) return;
      clearResults("Camera discovery is unavailable. You can enter Host / IP manually.");
      logWarning(error?.message || "Camera discovery failed.");
    } finally {
      if (token === sequence) setBusy(false);
    }
  }

  return {
    cancel,
    clearResults,
    discover,
    isBusy: () => busy
  };
}
