import { api } from "./api.js";

export function createVideoController({ state, selectedInputMode, onUpdate, renderInspectionEditor, renderResult, setStatus }) {
  function isActive() { return state.videoSession?.status === "running" || state.videoSession?.status === "stopping"; }

  async function loadResult(resultId) {
    if (!resultId || state.videoSeenResultIds.has(resultId)) return;
    const payload = await api(`/api/results/${encodeURIComponent(resultId)}`);
    state.videoSeenResultIds.add(resultId);
    state.result = payload.result;
    renderResult();
  }

  async function reload({ initial = false } = {}) {
    if (state.videoRefreshBusy) return;
    state.videoRefreshBusy = true;
    try {
      const payload = await api("/api/video/session");
      state.videoSession = payload.session || null;
      const resultId = state.videoSession?.latestResultId;
      if (resultId) {
        if (initial && !isActive()) state.videoSeenResultIds.add(resultId);
        else if (!state.videoSeenResultIds.has(resultId)) {
          await loadResult(resultId).catch((error) => setStatus(error.message || "Video result could not be loaded.", "warning"));
        }
      }
      onUpdate();
    } catch (error) {
      if (selectedInputMode() === "video") setStatus(error.message || "Video session status could not be loaded.", "error");
    } finally {
      state.videoRefreshBusy = false;
    }
  }

  async function start() {
    if (state.videoBusy || isActive()) return;
    try {
      state.videoBusy = true;
      onUpdate();
      await state.inspectionSavePromise;
      if (state.inspectionDirty || !state.selectedInspectionId) throw new Error("Inspection settings are not saved yet.");
      if (!state.selectedCameraId) throw new Error("Select a configured camera before starting video analysis.");
      const payload = await api("/api/video/session", {
        method: "POST",
        body: JSON.stringify({ cameraId: state.selectedCameraId, inspectionId: state.selectedInspectionId })
      });
      state.videoSession = payload.session || null;
      setStatus("Video analysis started.", "success");
    } catch (error) {
      setStatus(error.message || "Video analysis could not be started.", "error");
    } finally {
      state.videoBusy = false;
      renderInspectionEditor();
      onUpdate();
    }
  }

  async function stop() {
    if (state.videoBusy || !isActive()) return;
    try {
      state.videoBusy = true;
      onUpdate();
      const payload = await api("/api/video/session", { method: "DELETE" });
      state.videoSession = payload.session || state.videoSession;
      const resultId = state.videoSession?.latestResultId;
      if (resultId && !state.videoSeenResultIds.has(resultId)) await loadResult(resultId);
      if (state.videoSession?.status === "failed") setStatus(state.videoSession.lastError || "Video session failed.", "error");
      else setStatus("Video analysis stopped.", "success");
    } catch (error) {
      setStatus(error.message || "Video analysis could not be stopped.", "error");
      await reload().catch(() => undefined);
    } finally {
      state.videoBusy = false;
      renderInspectionEditor();
      onUpdate();
    }
  }

  function seed(payload) {
    state.videoSession = payload?.session || null;
    if (!isActive() && state.videoSession?.latestResultId) state.videoSeenResultIds.add(state.videoSession.latestResultId);
  }

  return { isActive, loadResult, reload, seed, start, stop };
}
