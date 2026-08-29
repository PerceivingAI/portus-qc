import { api } from "./api.js";
import { setMessage } from "./ui.js";

export function createScheduleController({ state, elements, onUpdate, renderResult }) {
  let editingId = "";

  function intervalParts(intervalMs) {
    if (intervalMs % 3_600_000 === 0) return { value: intervalMs / 3_600_000, unit: "hours" };
    if (intervalMs % 60_000 === 0) return { value: intervalMs / 60_000, unit: "minutes" };
    return { value: intervalMs / 1_000, unit: "seconds" };
  }

  function intervalText(intervalMs) {
    const parts = intervalParts(intervalMs);
    const unit = parts.value === 1 ? parts.unit.replace(/s$/u, "") : parts.unit;
    return `Every ${parts.value} ${unit}`;
  }

  function intervalMs() {
    const value = Number(elements.scheduleIntervalValue.value);
    if (!Number.isInteger(value) || value < 1) throw new Error("Schedule interval must be a positive whole number.");
    const factor = elements.scheduleIntervalUnit.value === "hours" ? 3_600_000 : elements.scheduleIntervalUnit.value === "minutes" ? 60_000 : 1_000;
    const result = value * factor;
    const policy = state.schedulePolicy;
    if (!policy) throw new Error("Scheduling service is unavailable.");
    if (result < policy.minIntervalMs || result > policy.maxIntervalMs) {
      throw new Error(`Schedule interval must be between ${policy.minIntervalMs / 1000} seconds and ${policy.maxIntervalMs / 3_600_000} hours.`);
    }
    return result;
  }

  function formatTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
  }

  function cameraLabel(cameraId) {
    const camera = state.cameras.find((item) => item.id === cameraId);
    if (!camera) return "Unavailable camera";
    return camera.alias?.trim() || `Camera ${camera.slot}`;
  }

  function taskState(schedule) {
    const running = Boolean(schedule.lastRunAt && (!schedule.lastFinishedAt || new Date(schedule.lastRunAt).getTime() > new Date(schedule.lastFinishedAt).getTime()));
    if (running) return { label: "Running", state: "running" };
    if (!schedule.enabled) return { label: "Disabled", state: "disabled" };
    if (schedule.lastStatus === "failed") return { label: "Failed", state: "failed" };
    if (schedule.lastStatus === "dropped") return { label: schedule.droppedCount ? `Dropped (${schedule.droppedCount})` : "Dropped", state: "dropped" };
    return { label: "Armed", state: "armed" };
  }

  function message(value = "", tone = "") { setMessage(elements.scheduleMessage, value, tone); }
  function isOpen() { return elements.scheduledTasksDialog.open; }

  function populateCameraOptions(preferredId = "") {
    const selected = preferredId || elements.scheduleCamera.value || state.selectedCameraId;
    elements.scheduleCamera.replaceChildren();
    for (const camera of [...state.cameras].sort((a, b) => a.slot - b.slot)) {
      const option = document.createElement("option");
      option.value = camera.id;
      option.textContent = camera.alias?.trim() ? `Camera ${camera.slot} · ${camera.alias.trim()}` : `Camera ${camera.slot}`;
      elements.scheduleCamera.append(option);
    }
    if (selected && state.cameras.some((camera) => camera.id === selected)) elements.scheduleCamera.value = selected;
  }

  function resetEditor({ keepMessage = false } = {}) {
    editingId = "";
    elements.scheduleEditorTitle.textContent = "New Task";
    populateCameraOptions(state.selectedCameraId);
    elements.scheduleCapability.value = "detect";
    elements.schedulePrompt.value = "";
    elements.scheduleIntervalValue.value = "1";
    elements.scheduleIntervalUnit.value = "minutes";
    elements.scheduleEnabled.checked = true;
    elements.scheduleSaveLabel.textContent = "Save Schedule";
    elements.scheduleCancelEdit.hidden = true;
    if (!keepMessage) message();
    render();
  }

  function loadEditor(schedule) {
    editingId = schedule.id;
    elements.scheduleEditorTitle.textContent = "Edit Task";
    populateCameraOptions(schedule.cameraId);
    elements.scheduleCapability.value = schedule.capability;
    elements.schedulePrompt.value = schedule.prompt;
    const parts = intervalParts(schedule.intervalMs);
    elements.scheduleIntervalValue.value = String(parts.value);
    elements.scheduleIntervalUnit.value = parts.unit;
    elements.scheduleEnabled.checked = schedule.enabled;
    elements.scheduleSaveLabel.textContent = "Save Changes";
    elements.scheduleCancelEdit.hidden = false;
    message();
    render();
    elements.schedulePrompt.focus();
  }

  function actionButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.disabled = state.scheduleBusy;
    button.addEventListener("click", onClick);
    return button;
  }

  function renderRows() {
    elements.scheduledTaskList.replaceChildren();
    if (!state.schedules.length) {
      const empty = document.createElement("div");
      empty.className = "scheduled-task-empty";
      empty.textContent = "No scheduled tasks yet.";
      elements.scheduledTaskList.append(empty);
      return;
    }

    for (const schedule of state.schedules) {
      const row = document.createElement("article");
      row.className = "scheduled-task-row";
      row.dataset.scheduleId = schedule.id;

      const main = document.createElement("div");
      main.className = "scheduled-task-main";
      const primary = document.createElement("div");
      primary.className = "scheduled-task-primary";
      const camera = document.createElement("strong");
      camera.textContent = cameraLabel(schedule.cameraId);
      const capability = document.createElement("span");
      capability.className = "scheduled-task-capability";
      capability.textContent = schedule.capability;
      const prompt = document.createElement("span");
      prompt.className = "scheduled-task-prompt";
      prompt.textContent = schedule.prompt;
      prompt.title = schedule.prompt;
      primary.append(camera, capability, prompt);

      const secondary = document.createElement("div");
      secondary.className = "scheduled-task-secondary";
      const interval = document.createElement("span");
      interval.textContent = intervalText(schedule.intervalMs);
      const next = document.createElement("span");
      next.textContent = `Next ${schedule.enabled ? formatTime(schedule.nextRunAt) : "—"}`;
      const status = document.createElement("span");
      const statusValue = taskState(schedule);
      status.className = "scheduled-task-status";
      status.dataset.state = statusValue.state;
      status.textContent = statusValue.label;
      secondary.append(interval, next, status);
      main.append(primary, secondary);

      const actions = document.createElement("div");
      actions.className = "scheduled-task-actions";
      actions.append(
        actionButton(schedule.enabled ? "Disarm" : "Arm", "secondary-button", () => { void setEnabled(schedule, !schedule.enabled); }),
        actionButton("Edit", "secondary-button", () => loadEditor(schedule)),
        actionButton("Delete", "danger-button", () => { void remove(schedule); })
      );
      row.append(main, actions);
      elements.scheduledTaskList.append(row);
    }
  }

  function render() {
    if (!isOpen()) return;
    populateCameraOptions(elements.scheduleCamera.value || state.selectedCameraId);
    const max = state.schedulePolicy?.maxSchedules ?? 10;
    elements.scheduleCount.textContent = `${state.schedules.length} of ${max} scheduled tasks`;
    const unavailable = !state.schedulePolicy || state.cameras.length === 0;
    const atLimit = !editingId && state.schedules.length >= max;
    const disabled = state.scheduleBusy || unavailable;
    for (const control of [elements.scheduleCamera, elements.scheduleCapability, elements.schedulePrompt, elements.scheduleIntervalValue, elements.scheduleIntervalUnit, elements.scheduleEnabled]) {
      control.disabled = disabled;
    }
    elements.scheduleSave.disabled = disabled || atLimit;
    elements.scheduleCancelEdit.disabled = state.scheduleBusy;
    if (!state.scheduleBusy) {
      if (!state.schedulePolicy) message("Scheduling service is unavailable.", "error");
      else if (!state.cameras.length) message("Configure a camera before creating a scheduled task.", "warning");
      else if (atLimit) message(`The ${max}-task limit has been reached. Delete a task before creating another.`, "warning");
    }
    renderRows();
  }

  async function loadResult(resultId) {
    if (!resultId || state.scheduleSeenResultIds.has(resultId)) return;
    const payload = await api(`/api/results/${encodeURIComponent(resultId)}`);
    state.scheduleSeenResultIds.add(resultId);
    state.result = payload.result;
    renderResult();
  }

  async function reload({ initial = false } = {}) {
    if (state.scheduleRefreshBusy) return;
    state.scheduleRefreshBusy = true;
    try {
      const payload = await api("/api/schedules");
      state.schedules = payload.schedules || [];
      state.schedulePolicy = payload.policy || null;
      if (initial) {
        for (const schedule of state.schedules) if (schedule.lastResultId) state.scheduleSeenResultIds.add(schedule.lastResultId);
      } else if (isOpen()) {
        const fresh = state.schedules
          .filter((schedule) => schedule.lastResultId && !state.scheduleSeenResultIds.has(schedule.lastResultId))
          .sort((a, b) => new Date(b.lastFinishedAt || 0).getTime() - new Date(a.lastFinishedAt || 0).getTime())[0];
        if (fresh?.lastResultId) await loadResult(fresh.lastResultId).catch((error) => message(error.message || "Scheduled result could not be loaded.", "warning"));
      }
      render();
      onUpdate();
    } catch (error) {
      if (isOpen()) message(error.message || "Schedule status could not be loaded.", "warning");
    } finally {
      state.scheduleRefreshBusy = false;
    }
  }

  function payload() {
    const prompt = elements.schedulePrompt.value.trim();
    if (!prompt) throw new Error("Enter a prompt for the scheduled task.");
    if (!elements.scheduleCamera.value) throw new Error("Choose a camera for the scheduled task.");
    return {
      cameraId: elements.scheduleCamera.value,
      prompt,
      capability: elements.scheduleCapability.value,
      intervalMs: intervalMs(),
      enabled: elements.scheduleEnabled.checked
    };
  }

  async function save(event) {
    event?.preventDefault();
    if (state.scheduleBusy) return;
    let feedback = "";
    let tone = "";
    try {
      state.scheduleBusy = true;
      render();
      const body = payload();
      const path = editingId ? `/api/schedules/${encodeURIComponent(editingId)}` : "/api/schedules";
      const response = await api(path, { method: editingId ? "PUT" : "POST", body: JSON.stringify(body) });
      const index = state.schedules.findIndex((item) => item.id === response.schedule.id);
      if (index >= 0) state.schedules[index] = response.schedule;
      else state.schedules.push(response.schedule);
      feedback = editingId ? "Scheduled task updated." : "Scheduled task created.";
      tone = "success";
      resetEditor({ keepMessage: true });
    } catch (error) {
      feedback = error.message || "Scheduled task could not be saved.";
      tone = "error";
    } finally {
      state.scheduleBusy = false;
      render();
      if (feedback) message(feedback, tone);
    }
  }

  async function setEnabled(schedule, enabled) {
    if (state.scheduleBusy) return;
    try {
      state.scheduleBusy = true;
      render();
      const response = await api(`/api/schedules/${encodeURIComponent(schedule.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      });
      const index = state.schedules.findIndex((item) => item.id === response.schedule.id);
      if (index >= 0) state.schedules[index] = response.schedule;
      if (editingId === response.schedule.id) elements.scheduleEnabled.checked = response.schedule.enabled;
      message(response.schedule.enabled ? "Scheduled task armed." : "Scheduled task disarmed.", "success");
    } catch (error) {
      message(error.message || "Scheduled task state could not be changed.", "error");
    } finally {
      state.scheduleBusy = false;
      render();
    }
  }

  async function remove(schedule) {
    if (state.scheduleBusy || !window.confirm("Delete this scheduled task?")) return;
    try {
      state.scheduleBusy = true;
      render();
      await api(`/api/schedules/${encodeURIComponent(schedule.id)}`, { method: "DELETE" });
      state.schedules = state.schedules.filter((item) => item.id !== schedule.id);
      if (editingId === schedule.id) resetEditor({ keepMessage: true });
      message("Scheduled task deleted.", "success");
    } catch (error) {
      message(error.message || "Scheduled task could not be deleted.", "error");
    } finally {
      state.scheduleBusy = false;
      render();
    }
  }

  function open() {
    if (!elements.scheduledTasksDialog.open) elements.scheduledTasksDialog.showModal();
    resetEditor();
    void reload();
  }

  function close() {
    if (state.scheduleBusy) return;
    if (elements.scheduledTasksDialog.open) elements.scheduledTasksDialog.close();
  }

  function bind() {
    elements.scheduledTasksClose.addEventListener("click", close);
    elements.scheduleForm.addEventListener("submit", save);
    elements.scheduleCancelEdit.addEventListener("click", () => resetEditor());
    elements.scheduledTasksDialog.addEventListener("click", (event) => { if (event.target === elements.scheduledTasksDialog) close(); });
    elements.scheduledTasksDialog.addEventListener("cancel", (event) => { if (state.scheduleBusy) event.preventDefault(); });
    elements.scheduledTasksDialog.addEventListener("close", () => { editingId = ""; message(); });
  }

  function seed(payload) {
    state.schedules = payload?.schedules || [];
    state.schedulePolicy = payload?.policy || null;
    for (const schedule of state.schedules) if (schedule.lastResultId) state.scheduleSeenResultIds.add(schedule.lastResultId);
  }

  return { bind, close, isOpen, open, reload, render, seed };
}
