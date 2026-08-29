import { api } from "./api.js";
import { setLucideIcon } from "./icons.js";
import { setMessage, setSecretVisibility } from "./ui.js";

export function createMoondreamSettingsController({
  dialog,
  openButton,
  closeButton,
  modelInput,
  apiKeyInput,
  apiKeyToggle,
  message,
  saveButton,
  onViewChange = () => {}
}) {
  let view = null;
  let busy = false;

  function setVisible(visible) {
    setSecretVisibility(apiKeyInput, apiKeyToggle, visible, {
      showLabel: "Show API Key",
      hideLabel: "Hide API Key",
      setIcon: setLucideIcon
    });
  }

  function syncControls() {
    modelInput.disabled = busy;
    apiKeyInput.disabled = busy;
    apiKeyToggle.disabled = busy || apiKeyInput.value.length === 0;
    saveButton.disabled = busy;
  }

  function setBusy(value) {
    busy = Boolean(value);
    syncControls();
  }

  function render(nextView = view, apiKey = "") {
    view = nextView;
    modelInput.value = view?.model || "moondream3.1-9B-A2B";
    apiKeyInput.value = apiKey;
    apiKeyInput.placeholder = "Your API Key";
    setVisible(false);
    setMessage(message);
    syncControls();
    onViewChange(view);
  }

  async function loadApiKey() {
    const payload = await api("/api/inference/moondream/key", { headers: { "x-portus-qc-console-secret": "1" } });
    return payload.apiKey || "";
  }

  async function reload() {
    const payload = await api("/api/inference/moondream");
    const apiKey = payload.moondream?.configured ? await loadApiKey() : "";
    render(payload.moondream, apiKey);
    return payload.moondream;
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    try { await reload(); }
    catch (error) { setMessage(message, error.message || "Moondream settings could not be loaded.", "error"); }
  }

  async function save() {
    if (busy) return;
    const model = modelInput.value;
    const apiKey = apiKeyInput.value;
    try {
      setBusy(true);
      setMessage(message, "Saving settings…");
      const payload = await api("/api/inference/moondream", {
        method: "PUT",
        body: JSON.stringify({ model, apiKey })
      });
      let activeKey = apiKey.trim();
      if (!activeKey && payload.moondream?.configured) {
        try { activeKey = await loadApiKey(); } catch { activeKey = ""; }
      }
      render(payload.moondream, activeKey);
      setMessage(message, "Moondream settings saved.", "success");
    } catch (error) {
      setMessage(message, error.message || "Moondream settings could not be saved.", "error");
    } finally {
      setBusy(false);
    }
  }

  function clearSecret() {
    apiKeyInput.value = "";
    setVisible(false);
    syncControls();
  }

  function bind() {
    openButton.addEventListener("click", () => { void open(); });
    closeButton.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", clearSecret);
    saveButton.addEventListener("click", () => { void save(); });
    apiKeyToggle.addEventListener("click", () => setVisible(apiKeyInput.type === "password"));
    apiKeyInput.addEventListener("input", () => {
      if (!apiKeyInput.value) setVisible(false);
      syncControls();
    });
  }

  return {
    bind,
    getView: () => view,
    isBusy: () => busy,
    open,
    render,
    reload,
    save
  };
}
