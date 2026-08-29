import { api } from "./api.js";
import { createCameraDiscoveryController } from "./camera-discovery.js";
import { createLucideIcon, hydrateLucideIcons, setLucideIcon } from "./icons.js";
import { startConsoleLifecycle } from "./lifecycle.js";
import { createScheduleController } from "./schedules.js";
import { createMoondreamSettingsController } from "./settings.js";
import { createStatusReporter, setMessage, setSecretVisibility } from "./ui.js";
import { createVideoController } from "./video.js";
import { createViewer } from "./viewer.js";

hydrateLucideIcons();
const $ = (selector) => document.querySelector(selector);


const elements = {
  prompt: $("#inspection-prompt"),
  capabilityFieldset: $("#capability-fieldset"),
  artifactRoot: $("#artifact-root"),
  pickFolder: $("#pick-folder"),
  runButton: $("#run-button"),
  runLabel: $("#run-label"),
  fileInput: $("#file-input"),
  fileInputMode: $("#file-input-mode"),
  fileFormatHelp: $("#file-format-help"),
  videoFormatHelp: $("#video-format-help"),
  scheduledTasksDialog: $("#scheduled-tasks-dialog"),
  scheduledTasksClose: $("#scheduled-tasks-close"),
  scheduleForm: $("#schedule-form"),
  scheduleEditorTitle: $("#schedule-editor-title"),
  scheduleCount: $("#schedule-count"),
  scheduleCamera: $("#schedule-camera"),
  scheduleCapability: $("#schedule-capability"),
  schedulePrompt: $("#schedule-prompt"),
  scheduleIntervalValue: $("#schedule-interval-value"),
  scheduleIntervalUnit: $("#schedule-interval-unit"),
  scheduleEnabled: $("#schedule-enabled"),
  scheduleMessage: $("#schedule-message"),
  scheduleCancelEdit: $("#schedule-cancel-edit"),
  scheduleSave: $("#schedule-save"),
  scheduleSaveLabel: $("#schedule-save-label"),
  scheduledTaskList: $("#scheduled-task-list"),
  cameraStatus: $("#camera-status"),
  cameraStatusLabel: $("#camera-status-label"),
  cameraAlias: $("#camera-alias"),
  cameraSlotSelectors: $("#camera-slot-selectors"),
  calibrationButton: $("#calibration-button"),
  calibrationDialog: $("#calibration-dialog"),
  calibrationClose: $("#calibration-close"),
  calibrationSpinner: $("#calibration-spinner"),
  calibrationMessage: $("#calibration-message"),
  sourceViewport: $("#source-viewport"),
  resultViewport: $("#result-viewport"),
  resultPanel: $("#result-panel"),
  resultCapability: $("#result-capability"),
  resultPanelHeader: $("#result-panel-header"),
  resultPanelKicker: $("#result-panel-kicker"),
  resultPanelTitle: $("#result-panel-title"),
  resultHeaderActions: $("#result-header-actions"),
  cameraManagerButton: $("#camera-manager-button"),
  cameraManager: $("#camera-manager"),
  cameraRefreshButton: $("#camera-refresh-button"),
  cameraRefreshIndicator: $("#camera-refresh-indicator"),
  cameraManagerMessage: $("#camera-manager-message"),
  cameraSlots: $("#camera-slots"),
  cameraEditorOverlay: $("#camera-editor-overlay"),
  settingsButton: $("#settings-button"),
  settingsDialog: $("#settings-dialog"),
  settingsClose: $("#settings-close"),
  moondreamModel: $("#moondream-model"),
  moondreamApiKey: $("#moondream-api-key"),
  moondreamApiKeyToggle: $("#moondream-api-key-toggle"),
  moondreamMessage: $("#moondream-message"),
  moondreamSave: $("#moondream-save"),
  cameraEditorDialog: $("#camera-editor-dialog"),
  cameraEditorClose: $("#camera-editor-close"),
  cameraEditorKicker: $("#camera-editor-kicker"),
  cameraForm: $("#camera-form"),
  cameraDiscoverButton: $("#camera-discover-button"),
  cameraDiscoverySpinner: $("#camera-discovery-spinner"),
  cameraDiscoveryResults: $("#camera-discovery-results"),
  cameraAliasInput: $("#camera-alias-input"),
  cameraHost: $("#camera-host"),
  cameraPort: $("#camera-port"),
  cameraProtocol: $("#camera-protocol"),
  cameraStream: $("#camera-stream"),
  cameraPath: $("#camera-path"),
  cameraTransport: $("#camera-transport"),
  cameraRtspClient: $("#camera-rtsp-client"),
  cameraRtspAuth: $("#camera-rtsp-auth"),
  cameraUsername: $("#camera-username"),
  cameraPassword: $("#camera-password"),
  cameraPasswordToggle: $("#camera-password-toggle"),
  cameraCredentialHelp: $("#camera-credential-help"),
  cameraSettingsMessage: $("#camera-settings-message"),
  cameraConnectButton: $("#camera-connect-button"),
  cameraConnectLabel: $("#camera-connect-label"),
  cameraConnectSpinner: $("#camera-connect-spinner"),
  calibrationReport: $("#calibration-report"),
  statusToast: $("#status-toast")
};

const state = {
  cameras: [], inspections: [], selectedCameraId: "", savedCameraId: "", selectedInspectionId: "", result: null,
  busy: false, inspectionDirty: false, inspectionSavePromise: Promise.resolve(), cameraProbeSequence: 0,
  cameraManagerOpen: false, cameraManagerBusy: false, cameraRefreshBusy: false, draggedCameraId: "", cameraPreviewSequence: 0, cameraPreviewUrls: new Map(), cameraPreviewBlobs: new Map(), cameraPreviewFailures: new Set(), cameraSourcePreviewSequence: 0, cameraSourcePreviewUrl: "",
  cameraEditorSlot: 1, cameraEditorId: "", cameraEditorBusy: false,
  moondream: null,
  schedules: [], schedulePolicy: null, scheduleBusy: false, scheduleRefreshBusy: false, scheduleSeenResultIds: new Set(),
  videoSession: null, videoBusy: false, videoRefreshBusy: false, videoSeenResultIds: new Set(),
  selectedFile: null, selectedFileMimeType: "", selectedFileUrl: "", lastNonFileInputMode: "image", filePickerPending: false,
  visibleSourceBlob: null, visibleSourceMimeType: "", visibleSourceKind: "", calibrationBusy: false
};

const CONSOLE_INSPECTION_ID = "console-inspection";
const CONSOLE_INSPECTION_NAME = "Console inspection";
const CAMERA_FORM_DEFAULTS = Object.freeze({ protocol: "rtsp", stream: "stream1", transport: "tcp", rtspClient: "gortsplib", rtspAuth: "auto" });
const CALIBRATION_LABELS = Object.freeze({ lighting: "Lighting", obstruction: "Obstruction", focus: "Focus", glare: "Glare", framing: "Framing" });
const CALIBRATION_STATE_LABELS = Object.freeze({ ok: "Good", warning: "Review", "fix-required": "Improve", unknown: "Unknown" });


const setStatus = createStatusReporter(elements.statusToast);
const viewer = createViewer({
  sourceViewport: elements.sourceViewport,
  resultViewport: elements.resultViewport,
  resultCapability: elements.resultCapability,
  setStatus
});
const { createMedia, hideInferenceSpinner, showInferenceSpinner } = viewer;
const settings = createMoondreamSettingsController({
  dialog: elements.settingsDialog,
  openButton: elements.settingsButton,
  closeButton: elements.settingsClose,
  modelInput: elements.moondreamModel,
  apiKeyInput: elements.moondreamApiKey,
  apiKeyToggle: elements.moondreamApiKeyToggle,
  message: elements.moondreamMessage,
  saveButton: elements.moondreamSave,
  onViewChange: (view) => {
    state.moondream = view;
    updateRunState();
  }
});
function renderResult() { viewer.renderResult(state.result); }
const schedules = createScheduleController({
  state,
  elements,
  onUpdate: updateRunState,
  renderResult
});
const video = createVideoController({
  state,
  selectedInputMode,
  onUpdate: updateRunState,
  renderInspectionEditor,
  renderResult,
  setStatus
});

function cameraBySlot(slot) { return state.cameras.find((camera) => camera.slot === Number(slot)); }
function selectedCamera() { return state.cameras.find((camera) => camera.id === state.selectedCameraId); }
function selectedInspection() { return state.inspections.find((item) => item.id === state.selectedInspectionId); }
function editorCamera() { return state.cameras.find((camera) => camera.id === state.cameraEditorId); }
function selectedInputMode() { return document.querySelector('input[name="input-mode"]:checked')?.value || "image"; }
function videoSessionActive() { return video.isActive(); }
function reloadSchedules(options) { return schedules.reload(options); }

function loadVideoResult(resultId) { return video.loadResult(resultId); }
function reloadVideoSession(options) { return video.reload(options); }
function startVideoSession() { return video.start(); }
function stopVideoSession() { return video.stop(); }

function fileMimeType(file) {
  const declared = file?.type?.toLowerCase();
  if (declared === "image/jpeg" || declared === "image/png") return declared;
  const name = file?.name?.toLowerCase() || "";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  return "";
}

function setVisibleSource(blob, mimeType, url, kind) {
  state.visibleSourceBlob = blob;
  state.visibleSourceMimeType = mimeType || blob?.type || "";
  state.visibleSourceKind = kind;
  createMedia("source", url);
  updateRunState();
}

function releaseSelectedFileUrl() {
  if (state.selectedFileUrl) URL.revokeObjectURL(state.selectedFileUrl);
  state.selectedFileUrl = "";
}

function renderSelectedFileSource() {
  elements.fileFormatHelp.hidden = selectedInputMode() !== "file";
  if (selectedInputMode() !== "file" || !state.selectedFileUrl || !state.selectedFile) return;
  state.cameraSourcePreviewSequence += 1;
  setVisibleSource(state.selectedFile, state.selectedFileMimeType, state.selectedFileUrl, "file");
}

function selectInputFile() {
  const file = elements.fileInput.files?.[0];
  if (!file) return;
  state.filePickerPending = false;
  const mimeType = fileMimeType(file);
  if (!mimeType) {
    setStatus("Only JPEG and PNG files are supported.", "error");
    return;
  }
  releaseSelectedFileUrl();
  state.selectedFile = file;
  state.selectedFileMimeType = mimeType;
  state.selectedFileUrl = URL.createObjectURL(file);
  elements.fileInputMode.checked = true;
  renderSelectedFileSource();
  updateRunState();
}

function syncInputModePresentation({ preserveSource = false } = {}) {
  const inputMode = selectedInputMode();
  if (inputMode === "image" || inputMode === "video") state.lastNonFileInputMode = inputMode;
  elements.fileFormatHelp.hidden = inputMode !== "file";
  elements.videoFormatHelp.hidden = inputMode !== "video";
  if (inputMode === "video" || inputMode === "file") {
    const onDemand = document.querySelector('input[name="trigger-mode"][value="on-demand"]');
    if (onDemand) onDemand.checked = true;
    if (inputMode === "video") void reloadVideoSession();
  }
  if (!preserveSource) {
    if (inputMode === "file") renderSelectedFileSource();
    else void refreshSelectedCameraPreview();
  }
  updateRunState();
}

function restoreInputModeAfterFileCancel() {
  state.filePickerPending = false;
  const fallback = state.lastNonFileInputMode === "video" ? "video" : "image";
  const radio = document.querySelector(`input[name="input-mode"][value="${fallback}"]`);
  if (radio) radio.checked = true;
  syncInputModePresentation({ preserveSource: true });
}

async function captureFileInspection(file, mimeType, inspectionId) {
  const payload = await api("/api/runs/file", {
    method: "POST",
    headers: {
      "content-type": mimeType,
      "x-portus-qc-inspection-id": encodeURIComponent(inspectionId),
      "x-portus-qc-file-name": encodeURIComponent(file.name || "selected-image")
    },
    body: file
  });
  if (typeof payload?.captureId !== "string" || !payload.captureId) throw new Error("File capture response did not include a capture id.");
  return { captureId: payload.captureId };
}

function setCameraStatus(status) {
  const labels = { "no-camera": "No Camera", connecting: "Connecting...", ready: "Ready" };
  elements.cameraStatus.dataset.state = status;
  elements.cameraStatusLabel.textContent = labels[status] || labels["no-camera"];
}

function renderCameraAlias() {
  const alias = selectedCamera()?.alias?.trim();
  const displayingFile = state.visibleSourceKind === "file";
  elements.cameraAlias.hidden = displayingFile || !alias;
  elements.cameraAlias.textContent = displayingFile ? "" : alias || "";
}
async function persistSelectedCamera() {
  try {
    await api("/api/cameras/_actions/selection", {
      method: "PUT",
      body: JSON.stringify({ cameraId: state.selectedCameraId || null })
    });
  } catch (error) {
    setStatus(error?.message || "Camera selection could not be saved.", "warning");
  }
}


function renderCameraSelectors() {
  const displayingFile = state.visibleSourceKind === "file";
  elements.cameraSlotSelectors.hidden = displayingFile;
  for (const button of elements.cameraSlotSelectors.querySelectorAll("[data-camera-slot]")) {
    const camera = cameraBySlot(button.dataset.cameraSlot);
    button.disabled = displayingFile || state.busy || state.videoBusy || state.calibrationBusy || videoSessionActive() || !camera;
    button.classList.toggle("active", Boolean(camera && camera.id === state.selectedCameraId));
    button.title = camera ? camera.alias || `Camera ${camera.slot} — ${camera.host}` : `Camera ${button.dataset.cameraSlot} is not configured`;
    button.setAttribute("aria-pressed", camera && camera.id === state.selectedCameraId ? "true" : "false");
  }
}

function reconcileSelectedCamera(preferredId = state.selectedCameraId) {
  if (preferredId && state.cameras.some((camera) => camera.id === preferredId)) state.selectedCameraId = preferredId;
  else state.selectedCameraId = [...state.cameras].sort((a, b) => a.slot - b.slot)[0]?.id || "";
  void persistSelectedCamera();
  renderCameraSelectors();
  renderCameraAlias();
}

async function refreshCameraStatus() {
  const cameraId = state.selectedCameraId;
  const sequence = ++state.cameraProbeSequence;
  if (!cameraId) { setCameraStatus("no-camera"); return; }
  setCameraStatus("connecting");
  try {
    const payload = await api(`/api/cameras/${encodeURIComponent(cameraId)}/test`, { method: "POST" });
    if (sequence !== state.cameraProbeSequence || cameraId !== state.selectedCameraId) return;
    setCameraStatus(payload?.probe?.reachable ? "ready" : "no-camera");
  } catch (error) {
    if (sequence !== state.cameraProbeSequence || cameraId !== state.selectedCameraId) return;
    setCameraStatus("no-camera");
    setStatus(error?.message || "Camera connection test failed.", "warning");
  }
}

async function refreshSelectedCameraPreview() {
  const cameraId = state.selectedCameraId;
  if (selectedInputMode() === "file") return;
  const sequence = ++state.cameraSourcePreviewSequence;
  if (!cameraId) {
    if (state.cameraSourcePreviewUrl) URL.revokeObjectURL(state.cameraSourcePreviewUrl);
    state.cameraSourcePreviewUrl = "";
    return;
  }
  try {
    if (state.cameraManagerOpen) return;
    setCameraStatus("connecting");
    const response = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/preview`, { method: "POST", cache: "no-store" });
    if (!response.ok) throw new Error(`Camera preview failed (${response.status}).`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("Camera preview response was empty.");
    const url = URL.createObjectURL(blob);
    if (sequence !== state.cameraSourcePreviewSequence || cameraId !== state.selectedCameraId) {
      URL.revokeObjectURL(url);
      return;
    }
    if (state.calibrationBusy) {
      URL.revokeObjectURL(url);
      if (state.visibleSourceBlob) setCameraStatus("ready");
      return;
    }
    if (state.cameraSourcePreviewUrl) URL.revokeObjectURL(state.cameraSourcePreviewUrl);
    state.cameraSourcePreviewUrl = url;
    setCameraStatus("ready");
    setVisibleSource(blob, blob.type || response.headers.get("content-type") || "image/jpeg", url, "camera");
  } catch (error) {
    if (sequence === state.cameraSourcePreviewSequence && cameraId === state.selectedCameraId) {
      setCameraStatus("no-camera");
      setStatus(error?.message || "Camera preview failed.", "warning");
    }
  }
}

function selectCameraBySlot(slot) {
  const camera = cameraBySlot(slot);
  if (!camera || state.busy || state.calibrationBusy || selectedInputMode() === "file") return;
  state.selectedCameraId = camera.id;
  renderCameraSelectors();
  renderCameraAlias();
  updateRunState();
  void refreshSelectedCameraPreview();
  void persistSelectedCamera();

}

function setCameraManagerMessage(message = "", tone = "") { setMessage(elements.cameraManagerMessage, message, tone); }

let cameraRefreshIndicatorTimer = 0;

function setCameraRefreshIndicator(mode = "idle") {
  if (cameraRefreshIndicatorTimer) {
    clearTimeout(cameraRefreshIndicatorTimer);
    cameraRefreshIndicatorTimer = 0;
  }
  elements.cameraRefreshIndicator.replaceChildren();
  if (mode === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "camera-action-spinner active";
    elements.cameraRefreshIndicator.append(spinner);
    return;
  }
  if (mode === "success") {
    elements.cameraRefreshIndicator.append(createLucideIcon("check"));
    cameraRefreshIndicatorTimer = window.setTimeout(() => {
      cameraRefreshIndicatorTimer = 0;
      if (!state.cameraRefreshBusy) elements.cameraRefreshIndicator.replaceChildren();
    }, 1500);
  }
}

function releaseCameraPreview(cameraId) {
  const url = state.cameraPreviewUrls.get(cameraId);
  if (url) URL.revokeObjectURL(url);
  state.cameraPreviewUrls.delete(cameraId);
  state.cameraPreviewBlobs.delete(cameraId);
}

function releaseOrphanCameraPreviews() {
  const ids = new Set(state.cameras.map((camera) => camera.id));
  for (const cameraId of state.cameraPreviewUrls.keys()) if (!ids.has(cameraId)) releaseCameraPreview(cameraId);
  for (const cameraId of state.cameraPreviewFailures) if (!ids.has(cameraId)) state.cameraPreviewFailures.delete(cameraId);
}

function cameraSlotVisual(camera) {
  const visual = document.createElement("div");
  visual.className = "camera-slot-visual";
  const cached = state.cameraPreviewUrls.get(camera.id);
  if (cached) {
    const image = document.createElement("img");
    image.className = "camera-slot-preview";
    image.src = cached;
    image.alt = camera.alias ? `${camera.alias} preview` : `Camera ${camera.slot} preview`;
    image.draggable = false;
    visual.append(image);
  } else {
    const placeholder = document.createElement("span");
    placeholder.className = "camera-slot-preview-placeholder";
    placeholder.textContent = state.cameraPreviewFailures.has(camera.id) ? "Preview unavailable" : "Loading preview…";
    visual.append(placeholder);
  }
  const meta = document.createElement("div");
  meta.className = "camera-slot-meta";
  const name = document.createElement("strong"); name.textContent = camera.alias || `Camera ${camera.slot}`;
  const host = document.createElement("span"); host.textContent = camera.port ? `${camera.host}:${camera.port}` : camera.host;
  meta.append(name, host); visual.append(meta);
  return visual;
}

async function refreshCameraManagerPreviews() {
  if (!state.cameraManagerOpen) return;
  const sequence = ++state.cameraPreviewSequence;
  const cameras = [...state.cameras];
  await Promise.allSettled(cameras.map(async (camera) => {
    state.cameraPreviewFailures.delete(camera.id);
    try {
      const response = await fetch(`/api/cameras/${encodeURIComponent(camera.id)}/preview`, { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error(`Preview failed (${response.status}).`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("Preview response was empty.");
      const url = URL.createObjectURL(blob);
      if (sequence !== state.cameraPreviewSequence || !state.cameraManagerOpen || !state.cameras.some((item) => item.id === camera.id)) {
        URL.revokeObjectURL(url);
        return;
      }
      releaseCameraPreview(camera.id);
      state.cameraPreviewUrls.set(camera.id, url);
      state.cameraPreviewBlobs.set(camera.id, blob);
    } catch {
      if (sequence === state.cameraPreviewSequence && state.cameraManagerOpen && state.cameras.some((item) => item.id === camera.id)) {
        releaseCameraPreview(camera.id);
        state.cameraPreviewFailures.add(camera.id);
      }
    }
  }));
  if (sequence === state.cameraPreviewSequence && state.cameraManagerOpen) {
    renderCameraManager();
    const sourceUrl = state.cameraPreviewUrls.get(state.selectedCameraId);
    const sourceBlob = state.cameraPreviewBlobs.get(state.selectedCameraId);
    if (sourceUrl && sourceBlob && selectedInputMode() !== "file" && !state.calibrationBusy) {
      setCameraStatus("ready");
      setVisibleSource(sourceBlob, sourceBlob.type || "image/jpeg", sourceUrl, "camera");
    }
  }
}

function setCameraManagerOpen(open) {
  if (!open && elements.cameraEditorDialog.open && elements.cameraEditorDialog.classList.contains("add-mode")) {
    if (state.cameraEditorBusy) return;
    closeCameraEditor();
  }
  state.cameraManagerOpen = Boolean(open);
  elements.cameraManager.hidden = !state.cameraManagerOpen;
  elements.resultViewport.hidden = state.cameraManagerOpen;
  elements.resultPanelHeader.hidden = state.cameraManagerOpen;
  elements.resultPanel.classList.toggle("camera-management-open", state.cameraManagerOpen);
  elements.cameraManagerButton.setAttribute("aria-pressed", state.cameraManagerOpen ? "true" : "false");
  if (state.cameraManagerOpen) {
    renderCameraManager();
    void refreshCameraManagerPreviews();
  } else {
    state.cameraPreviewSequence += 1;
    state.draggedCameraId = "";
    setCameraManagerMessage();
    setCameraRefreshIndicator("idle");
  }
}

function configureCameraDropTarget(card, slot) {
  card.dataset.cameraSlot = String(slot);
  card.addEventListener("dragover", (event) => {
    const source = state.cameras.find((camera) => camera.id === state.draggedCameraId);
    if (!source || source.slot === slot || state.cameraManagerBusy) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    card.classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", (event) => {
    event.preventDefault();
    card.classList.remove("drag-over");
    const cameraId = state.draggedCameraId || event.dataTransfer?.getData("text/plain") || "";
    if (cameraId) void moveCameraToSlot(cameraId, slot);
  });
}

function renderCameraManager() {
  elements.cameraRefreshButton.disabled = state.cameraRefreshBusy || state.cameraManagerBusy || state.calibrationBusy;
  elements.cameraRefreshButton.setAttribute("aria-busy", state.cameraRefreshBusy ? "true" : "false");
  elements.cameraSlots.replaceChildren();
  for (let slot = 1; slot <= 4; slot += 1) {
    const camera = cameraBySlot(slot);
    const card = document.createElement("article");
    card.className = `camera-slot-card${camera ? "" : " empty"}${camera?.id === state.selectedCameraId ? " selected" : ""}`;
    configureCameraDropTarget(card, slot);

    if (camera) {
      card.dataset.cameraId = camera.id;
      card.draggable = !state.cameraManagerBusy;
      card.title = "Drag to another camera slot to rearrange";
      card.addEventListener("dragstart", (event) => {
        if (state.cameraManagerBusy) { event.preventDefault(); return; }
        state.draggedCameraId = camera.id;
        card.classList.add("dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", camera.id);
        }
      });
      card.addEventListener("dragend", () => {
        state.draggedCameraId = "";
        card.classList.remove("dragging");
        for (const target of elements.cameraSlots.querySelectorAll(".drag-over")) target.classList.remove("drag-over");
      });
      const visual = cameraSlotVisual(camera);
      visual.tabIndex = 0;
      visual.setAttribute("role", "button");
      visual.setAttribute("aria-label", `Select camera ${slot}`);
      visual.addEventListener("click", () => selectCameraBySlot(slot));
      visual.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectCameraBySlot(slot); } });

      const footer = document.createElement("div"); footer.className = "camera-slot-footer";
      const number = document.createElement("span"); number.className = "camera-slot-number"; number.textContent = `Camera ${slot}`;
      const actions = document.createElement("div"); actions.className = "camera-slot-actions";
      const edit = document.createElement("button"); edit.type = "button"; edit.className = "edit-camera"; edit.append(createLucideIcon("square-pen")); edit.setAttribute("aria-label", `Edit camera ${slot}`); edit.title = `Edit camera ${slot}`; edit.disabled = state.cameraManagerBusy; edit.draggable = false; edit.addEventListener("click", () => openCameraEditor(slot, camera.id));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "delete-camera"; remove.append(createLucideIcon("trash-2")); remove.setAttribute("aria-label", `Delete camera ${slot}`); remove.title = `Delete camera ${slot}`; remove.disabled = state.cameraManagerBusy; remove.draggable = false; remove.addEventListener("click", () => { void deleteCamera(camera.id); });
      actions.append(edit, remove); footer.append(number, actions); card.append(visual, footer);
    } else {
      const visual = document.createElement("div"); visual.className = "camera-slot-visual";
      const empty = document.createElement("strong"); empty.textContent = "Empty";
      const hint = document.createElement("span"); hint.textContent = "Select the add button to connect a camera";
      visual.append(empty, hint);
      const footer = document.createElement("div"); footer.className = "camera-slot-footer camera-slot-empty-footer";
      const number = document.createElement("span"); number.className = "camera-slot-number"; number.textContent = `Camera ${slot}`;
      const add = document.createElement("button"); add.type = "button"; add.className = "camera-slot-add"; add.append(createLucideIcon("plus")); add.setAttribute("aria-label", `Add camera ${slot}`); add.title = `Add camera ${slot}`; add.disabled = state.cameraManagerBusy; add.addEventListener("click", () => openCameraEditor(slot));
      footer.append(number, add); card.append(visual, footer);
    }
    elements.cameraSlots.append(card);
  }
}

async function reloadCameras(preferredId = state.selectedCameraId, { refreshPreviews = true } = {}) {
  const payload = await api("/api/cameras");
  state.cameras = [...(payload.cameras || [])].sort((a, b) => a.slot - b.slot);
  releaseOrphanCameraPreviews();
  reconcileSelectedCamera(preferredId);
  if (!state.cameraManagerOpen) void refreshSelectedCameraPreview();
  renderCameraManager();
  updateRunState();
  if (refreshPreviews && state.cameraManagerOpen && !state.cameraManagerBusy) void refreshCameraManagerPreviews();
  return state.cameras;
}

async function refreshConfiguredCameras() {
  if (!state.cameraManagerOpen || state.cameraManagerBusy || state.cameraRefreshBusy) return;
  const preferredId = state.selectedCameraId;
  let showSuccessCheck = false;
  try {
    state.cameraRefreshBusy = true;
    state.cameraManagerBusy = true;
    elements.cameraManager.classList.add("busy");
    setCameraRefreshIndicator("loading");
    setCameraManagerMessage();
    renderCameraManager();
    await reloadCameras(preferredId, { refreshPreviews: false });
    if (!state.cameraManagerOpen) return;
    await refreshCameraManagerPreviews();
    if (!state.cameraManagerOpen) return;
    const available = state.cameras.filter((camera) => state.cameraPreviewUrls.has(camera.id)).length;
    if (state.selectedCameraId && state.cameraPreviewFailures.has(state.selectedCameraId) && selectedInputMode() !== "file") setCameraStatus("no-camera");
    if (!state.cameras.length) setCameraManagerMessage("No configured cameras to refresh.");
    else if (available === state.cameras.length) {
      setCameraManagerMessage();
      showSuccessCheck = true;
    } else setCameraManagerMessage(`Refresh complete. ${available} of ${state.cameras.length} cameras available.`);
  } catch (error) {
    if (state.cameraManagerOpen) setCameraManagerMessage(error?.message || "Configured cameras could not be refreshed.", "error");
  } finally {
    state.cameraRefreshBusy = false;
    state.cameraManagerBusy = false;
    elements.cameraManager.classList.remove("busy");
    renderCameraManager();
    setCameraRefreshIndicator(state.cameraManagerOpen && showSuccessCheck ? "success" : "idle");
  }
}

async function moveCameraToSlot(cameraId, slot) {
  if (state.cameraManagerBusy) return;
  const camera = state.cameras.find((item) => item.id === cameraId);
  if (!camera || camera.slot === Number(slot)) return;
  const selectedId = state.selectedCameraId;
  try {
    state.cameraManagerBusy = true;
    elements.cameraManager.classList.add("busy");
    setCameraManagerMessage(`Moving ${camera.alias || `Camera ${camera.slot}`} to slot ${slot}…`);
    renderCameraManager();
    await api(`/api/cameras/${encodeURIComponent(camera.id)}/slot`, { method: "PUT", body: JSON.stringify({ slot: Number(slot) }) });
    await reloadCameras(selectedId);
  } catch (error) {
    setCameraManagerMessage(error.message || "Camera order could not be updated.", "error");
  } finally {
    state.cameraManagerBusy = false;
    state.draggedCameraId = "";
    elements.cameraManager.classList.remove("busy");
    renderCameraManager();
    if (state.cameraManagerOpen) void refreshCameraManagerPreviews();
  }
}

function clearCalibrationReport() {
  elements.calibrationReport.hidden = true;
  elements.calibrationReport.replaceChildren();
}

function renderCalibrationReport(report) {
  elements.calibrationReport.replaceChildren();
  const grid = document.createElement("div"); grid.className = "calibration-checks";
  for (const check of report.checks || []) {
    if (!(check.id in CALIBRATION_LABELS)) continue;
    const item = document.createElement("article"); item.className = "calibration-check";
    const itemHeading = document.createElement("div"); itemHeading.className = "calibration-check-heading";
    const label = document.createElement("strong"); label.textContent = CALIBRATION_LABELS[check.id];
    const stateLabel = document.createElement("span"); stateLabel.className = `calibration-state state-${check.state || "unknown"}`; stateLabel.textContent = CALIBRATION_STATE_LABELS[check.state] || "Unknown";
    const message = document.createElement("p"); message.textContent = check.message || "No guidance returned.";
    itemHeading.append(label, stateLabel); item.append(itemHeading, message); grid.append(item);
  }
  elements.calibrationReport.append(grid);
  elements.calibrationReport.hidden = false;
}

function setCameraEditorMessage(message = "", tone = "") { setMessage(elements.cameraSettingsMessage, message, tone); }

function setCameraPasswordVisible(visible) {
  setSecretVisibility(elements.cameraPassword, elements.cameraPasswordToggle, visible, {
    showLabel: "Show Password",
    hideLabel: "Hide Password",
    setIcon: setLucideIcon
  });
}

function syncCameraPasswordToggle() {
  elements.cameraPasswordToggle.disabled = state.cameraEditorBusy || elements.cameraPassword.value.length === 0;
}

function setCameraEditorBusy(busy) {
  state.cameraEditorBusy = busy;
  for (const control of elements.cameraForm.querySelectorAll("button,input,select")) control.disabled = busy;
  elements.cameraEditorClose.disabled = busy;
  elements.cameraConnectButton.setAttribute("aria-busy", String(busy));
  elements.cameraConnectSpinner.classList.toggle("active", busy);
  syncCameraPasswordToggle();
  updateRunState();
}

function clearCameraEditorSecrets() {
  elements.cameraUsername.value = "";
  elements.cameraPassword.value = "";
  setCameraPasswordVisible(false);
  syncCameraPasswordToggle();
}

function fillCameraEditor(camera, slot) {
  state.cameraEditorSlot = Number(slot);
  cameraDiscovery.cancel();
  state.cameraEditorId = camera?.id || "";
  elements.cameraEditorKicker.textContent = `${camera ? "EDIT CAMERA" : "ADD CAMERA"} ${slot}`;
  elements.cameraAliasInput.value = camera?.alias || "";
  elements.cameraHost.value = camera?.host || "";
  elements.cameraPort.value = camera?.port ? String(camera.port) : "";
  elements.cameraProtocol.value = camera?.protocol || CAMERA_FORM_DEFAULTS.protocol;
  elements.cameraStream.value = camera?.stream || CAMERA_FORM_DEFAULTS.stream;
  elements.cameraPath.value = camera?.path || "";
  elements.cameraTransport.value = camera?.transport || CAMERA_FORM_DEFAULTS.transport;
  elements.cameraRtspClient.value = camera?.rtspClient || CAMERA_FORM_DEFAULTS.rtspClient;
  elements.cameraRtspAuth.value = camera?.rtspAuth || CAMERA_FORM_DEFAULTS.rtspAuth;
  elements.cameraUsername.value = "";
  elements.cameraPassword.value = "";
  setCameraPasswordVisible(false);
  syncCameraPasswordToggle();
  elements.cameraConnectLabel.textContent = camera ? "Save Changes" : "Connect";
  if (camera?.credentialsConfigured) {
    elements.cameraCredentialHelp.textContent = "Saved camera credentials are loaded for editing.";
  } else if (camera) {
    elements.cameraCredentialHelp.textContent = "Enter both username and password to configure credentials.";
  } else {
    elements.cameraCredentialHelp.textContent = "Use RTSP/Camera Account Username and Password.";
  }
  cameraDiscovery.clearResults();
  setCameraEditorMessage();
}

function resetCameraEditorPresentation() {
  elements.cameraEditorOverlay.hidden = true;
  elements.cameraManager.classList.remove("camera-editor-open");
  elements.cameraEditorDialog.classList.remove("add-mode");
  if (elements.cameraEditorDialog.parentElement !== document.body) document.body.append(elements.cameraEditorDialog);
}

async function loadCameraEditorCredentials(cameraId) {
  try {
    const payload = await api(`/api/cameras/${encodeURIComponent(cameraId)}/credentials`, {
      headers: { "x-portus-qc-console-secret": "1" }
    });
    if (state.cameraEditorId !== cameraId || !elements.cameraEditorDialog.open) return;
    elements.cameraUsername.value = payload.credentials?.username || "";
    elements.cameraPassword.value = payload.credentials?.password || "";
    setCameraPasswordVisible(false);
    syncCameraPasswordToggle();
  } catch (error) {
    if (state.cameraEditorId === cameraId && elements.cameraEditorDialog.open) {
      setCameraEditorMessage(error?.message || "Saved camera credentials could not be loaded.", "error");
    }
  }
}

function openCameraEditor(slot, cameraId = "") {
  if (state.cameraEditorBusy) return;
  const camera = cameraId ? state.cameras.find((item) => item.id === cameraId) : undefined;
  fillCameraEditor(camera, slot);
  if (elements.cameraEditorDialog.open) return;
  elements.cameraManager.append(elements.cameraEditorDialog);
  elements.cameraEditorDialog.classList.add("add-mode");
  elements.cameraManager.classList.add("camera-editor-open");
  elements.cameraEditorOverlay.hidden = false;
  elements.cameraEditorDialog.show();
  if (camera?.credentialsConfigured) void loadCameraEditorCredentials(camera.id);
}

function closeCameraEditor() {
  if (state.cameraEditorBusy) return;
  cameraDiscovery.cancel();
  if (elements.cameraEditorDialog.open) elements.cameraEditorDialog.close();
}

function cameraFormPayload({ requireCredentials, includeSlot }) {
  if (!elements.cameraForm.reportValidity()) throw new Error("Complete the required camera fields before continuing.");
  const payload = {
    ...(includeSlot ? { slot: state.cameraEditorSlot } : {}),
    alias: elements.cameraAliasInput.value.trim(),
    host: elements.cameraHost.value.trim(),
    protocol: elements.cameraProtocol.value,
    stream: elements.cameraStream.value,
    transport: elements.cameraTransport.value,
    rtspClient: elements.cameraRtspClient.value,
    rtspAuth: elements.cameraRtspAuth.value
  };
  const portText = elements.cameraPort.value.trim();
  if (portText) payload.port = Number(portText);
  const path = elements.cameraPath.value.trim();
  if (path) payload.path = path;
  const username = elements.cameraUsername.value;
  const password = elements.cameraPassword.value;
  const hasUsername = username.length > 0;
  const hasPassword = password.length > 0;
  if (requireCredentials && (!username.trim() || !hasPassword)) throw new Error("Camera-local username and password are required to connect this camera.");
  if ((hasUsername || hasPassword) && (!username.trim() || !hasPassword)) throw new Error("Username and password must be supplied together.");
  if (hasUsername && hasPassword) { payload.username = username; payload.password = password; }
  return payload;
}

function cameraConnectionError(error) {
  if (error?.reason === "auth_invalid") return "Camera rejected the credentials. Verify the camera-local RTSP/Camera Account username and password, not the vendor/cloud login.";
  if (error?.reason === "server_locked") return "The camera RTSP service is locked after failed authentication attempts. Wait for the lockout to expire or reboot the camera before trying again.";
  if (error?.reason === "timeout") return "The camera connection timed out. Verify the camera is reachable on the local network and the selected connection settings are correct.";
  if (error?.reason === "stream_unavailable") return "The camera was reached, but the configured RTSP stream is unavailable. Check Stream, Path, Protocol and Port under Advanced settings.";
  return error?.message || "Camera could not be connected.";
}

async function submitCameraEditor(event) {
  event.preventDefault();
  if (state.cameraEditorBusy || cameraDiscovery.isBusy()) return;
  const existing = editorCamera();
  try {
    const body = cameraFormPayload({ requireCredentials: !existing, includeSlot: !existing });
    setCameraEditorBusy(true);
    if (!existing) {
      setCameraEditorMessage("Connecting camera…");
      const payload = await api("/api/cameras/_actions/connect", { method: "POST", body: JSON.stringify(body) });
      const preferred = state.cameras.length === 0 ? payload.camera.id : state.selectedCameraId;
      await reloadCameras(preferred);
    } else {
      setCameraEditorMessage("Saving camera changes…");
      const payload = await api(`/api/cameras/${encodeURIComponent(existing.id)}`, { method: "PUT", body: JSON.stringify(body) });
      await reloadCameras(state.selectedCameraId || payload.camera.id);
      const refreshed = state.cameras.find((camera) => camera.id === payload.camera.id) || payload.camera;
      fillCameraEditor(refreshed, refreshed.slot);
      setCameraEditorMessage("Camera changes saved.", "success");
    }
  } catch (error) {
    setCameraEditorMessage(cameraConnectionError(error), "error");
  } finally {
    setCameraEditorBusy(false);
    elements.cameraConnectLabel.textContent = editorCamera() ? "Save Changes" : "Connect";
  }
}

async function deleteCamera(cameraId) {
  const camera = state.cameras.find((item) => item.id === cameraId);
  if (!camera) return;
  if (!window.confirm(`Delete ${camera.alias || `Camera ${camera.slot}`}?`)) return;
  try {
    await api(`/api/cameras/${encodeURIComponent(camera.id)}`, { method: "DELETE" });
    const preferred = state.selectedCameraId === camera.id ? "" : state.selectedCameraId;
    await reloadCameras(preferred);
  } catch (error) { setStatus(error.message || "Camera could not be deleted.", "error"); }
}

function setCalibrationMessage(message = "", tone = "") { setMessage(elements.calibrationMessage, message, tone); }

function closeCalibrationDialog() {
  if (state.calibrationBusy) return;
  if (elements.calibrationDialog.open) elements.calibrationDialog.close();
}

async function runCalibrationReport() {
  const source = state.visibleSourceBlob;
  const mimeType = state.visibleSourceMimeType || source?.type || "";
  if (state.calibrationBusy || !source) return;
  if (!elements.calibrationDialog.open) elements.calibrationDialog.showModal();
  clearCalibrationReport();
  setCalibrationMessage("Evaluating the image currently shown in Input with Moondream…");
  try {
    state.calibrationBusy = true;
    elements.calibrationSpinner.classList.add("active");
    updateRunState();
    elements.calibrationClose.disabled = true;
    const payload = await api("/api/calibration", {
      method: "POST",
      headers: { "content-type": mimeType },
      body: source
    });
    renderCalibrationReport(payload.calibration);
    setCalibrationMessage("This report evaluates the image currently shown in Input.");
  } catch (error) {
    setCalibrationMessage(error.message || "Calibration report could not be created.", "error");
  } finally {
    state.calibrationBusy = false;
    elements.calibrationSpinner.classList.remove("active");
    elements.calibrationClose.disabled = false;
    updateRunState();
  }
}

function populateInspectionState() {
  const previousInspection = state.selectedInspectionId;
  if (state.inspections.some((item) => item.id === previousInspection)) state.selectedInspectionId = previousInspection;
  else if (state.inspections.some((item) => item.id === CONSOLE_INSPECTION_ID)) state.selectedInspectionId = CONSOLE_INSPECTION_ID;
  else state.selectedInspectionId = state.inspections.length === 1 ? state.inspections[0].id : "";
  renderInspectionEditor();
  updateRunState();
}

function renderInspectionEditor() {
  const inspection = selectedInspection();
  const locked = state.busy || state.videoBusy || videoSessionActive();
  elements.prompt.disabled = locked;
  elements.capabilityFieldset.disabled = locked;
  if (!inspection) {
    if (!state.inspectionDirty) {
      elements.prompt.value = "";
      for (const radio of document.querySelectorAll('input[name="capability"]')) radio.checked = radio.value === "query";
    }
    return;
  }
  elements.prompt.value = inspection.prompt;
  const radio = document.querySelector(`input[name="capability"][value="${inspection.capability}"]`);
  if (radio) radio.checked = true;
  state.inspectionDirty = false;
}

function updateRunState() {
  const inspection = selectedInspection();
  const draftReady = !inspection && elements.prompt.value.trim().length > 0 && Boolean(document.querySelector('input[name="capability"]:checked'));
  const inspectionReady = Boolean(inspection?.enabled) || draftReady;
  const inputMode = selectedInputMode();
  const videoMode = inputMode === "video";
  const fileMode = inputMode === "file";
  const videoActive = videoSessionActive();
  const inferenceReady = Boolean(state.moondream?.configured);

  if (videoMode) {
    elements.runButton.disabled = videoActive
      ? state.videoBusy || state.videoSession?.status === "stopping"
      : !(state.selectedCameraId && inspectionReady && state.moondream?.configured && !state.busy && !state.videoBusy && !state.calibrationBusy);
  } else if (fileMode) {
    elements.runButton.disabled = !(state.selectedFile && inspectionReady && state.moondream?.configured && !state.busy && !state.videoBusy && !state.calibrationBusy);
  } else {
    elements.runButton.disabled = !(state.selectedCameraId && inspectionReady && inferenceReady && !state.busy && !state.calibrationBusy);
  }

  const locked = state.busy || state.videoBusy || videoActive || state.calibrationBusy;
  elements.prompt.disabled = locked;
  elements.capabilityFieldset.disabled = locked;
  elements.pickFolder.disabled = locked;
  elements.artifactRoot.disabled = locked;
  elements.cameraManagerButton.disabled = locked || state.cameraEditorBusy;
  elements.settingsButton.disabled = locked;
  elements.calibrationButton.disabled = locked || !state.visibleSourceBlob || !inferenceReady;
  for (const radio of document.querySelectorAll('input[name="input-mode"]')) radio.disabled = locked;
  const scheduledRadio = document.querySelector('input[name="trigger-mode"][value="scheduled"]');
  if (scheduledRadio) scheduledRadio.disabled = locked || videoMode || fileMode;
  const onDemandRadio = document.querySelector('input[name="trigger-mode"][value="on-demand"]');
  if (onDemandRadio) onDemandRadio.disabled = locked;
  elements.cameraStatus.hidden = state.visibleSourceKind === "file";
  renderCameraAlias();
  renderCameraSelectors();
  schedules.render();
  if (videoMode) elements.runLabel.textContent = state.videoBusy
    ? (videoActive ? "Stopping…" : "Starting…")
    : videoActive
      ? "Stop"
      : "Start";
  else elements.runLabel.textContent = "Capture & Inspect";
}

async function saveInspectionIfNeeded() {
  const inspection = selectedInspection();
  if (!state.inspectionDirty) return inspection;
  const prompt = elements.prompt.value.trim();
  const capability = document.querySelector('input[name="capability"]:checked')?.value;
  if (!prompt) {
    if (inspection) {
      await api(`/api/inspections/${encodeURIComponent(inspection.id)}`, { method: "DELETE" });
      state.inspections = state.inspections.filter((item) => item.id !== inspection.id);
      state.selectedInspectionId = "";
    }
    state.inspectionDirty = false;
    updateRunState();
    return undefined;
  }
  if (!capability) throw new Error("Choose one inspection capability.");
  const payload = inspection
    ? await api(`/api/inspections/${encodeURIComponent(inspection.id)}`, { method: "PUT", body: JSON.stringify({ name: inspection.name, prompt, enabled: inspection.enabled, capability }) })
    : await api("/api/inspections", { method: "POST", body: JSON.stringify({ id: CONSOLE_INSPECTION_ID, name: CONSOLE_INSPECTION_NAME, prompt, enabled: true, capability }) });
  const index = state.inspections.findIndex((item) => item.id === payload.inspection.id);
  if (index >= 0) state.inspections[index] = payload.inspection;
  else state.inspections.push(payload.inspection);
  state.selectedInspectionId = payload.inspection.id;
  state.inspectionDirty = false;
  updateRunState();
  return payload.inspection;
}

async function captureSelectedInput(inspectionId) {
  if (selectedInputMode() === "file") {
    if (!state.selectedFile || !state.selectedFileMimeType) throw new Error("Select a JPEG or PNG file before inspecting.");
    return captureFileInspection(state.selectedFile, state.selectedFileMimeType, inspectionId);
  }
  if (!state.selectedCameraId) throw new Error("Select a configured camera before inspecting.");
  return captureInspection(state.selectedCameraId, inspectionId);
}

async function captureInspection(cameraId, inspectionId) {
  const payload = await api("/api/runs/capture", {
    method: "POST",
    body: JSON.stringify({ cameraId, inspectionId })
  });
  if (typeof payload?.captureId !== "string" || !payload.captureId) throw new Error("Capture response did not include a capture id.");
  return { captureId: payload.captureId };
}

function runPrimaryAction() {
  if (selectedInputMode() === "video") {
    if (videoSessionActive()) void stopVideoSession();
    else void startVideoSession();
  } else void runInspection();
}

async function loadInitialState() {
  const responses = await Promise.allSettled([api("/api/cameras"), api("/api/cameras/_actions/selection"), api("/api/inspections"), api("/api/artifacts/settings"), api("/api/inference/moondream"), api("/api/schedules"), api("/api/video/session")]);
  if (responses[0].status === "fulfilled") state.cameras = [...(responses[0].value.cameras || [])].sort((a, b) => a.slot - b.slot);
  if (responses[1].status === "fulfilled") state.savedCameraId = responses[1].value.cameraId || "";
  if (responses[2].status === "fulfilled") state.inspections = responses[2].value.inspections || [];
  if (responses[3].status === "fulfilled") elements.artifactRoot.value = responses[3].value.artifacts.root || "";
  if (responses[4].status === "fulfilled") state.moondream = responses[4].value.moondream || null;
  if (responses[5].status === "fulfilled") schedules.seed(responses[5].value);
  if (responses[6].status === "fulfilled") {
    video.seed(responses[6].value);
    if (videoSessionActive()) {
      const videoInput = document.querySelector('input[name="input-mode"][value="video"]');
      const onDemand = document.querySelector('input[name="trigger-mode"][value="on-demand"]');
      if (videoInput) videoInput.checked = true;
      if (onDemand) onDemand.checked = true;
    } else if (state.videoSession?.latestResultId) state.videoSeenResultIds.add(state.videoSession.latestResultId);
  }
  if (videoSessionActive() && state.inspections.some((inspection) => inspection.id === state.videoSession.inspectionId)) state.selectedInspectionId = state.videoSession.inspectionId;
  reconcileSelectedCamera(videoSessionActive() ? state.videoSession.cameraId : state.savedCameraId);
  renderCameraManager();
  populateInspectionState();
  settings.render(state.moondream);
  schedules.render();
  renderResult();
  setCameraManagerOpen(false);
  void refreshSelectedCameraPreview();
  if (videoSessionActive() && state.videoSession?.latestResultId && !state.videoSeenResultIds.has(state.videoSession.latestResultId)) void loadVideoResult(state.videoSession.latestResultId);
  const failures = responses.filter((item) => item.status === "rejected");
  if (failures.length) setStatus("Some local configuration could not be loaded.", "warning");
  else if (!state.cameras.length) setStatus("Console ready. Configure a camera before running.");
  else setStatus("Console ready.", "success");
}

async function runInspection() {
  if (state.busy) return;
  try {
    state.busy = true; updateRunState(); elements.prompt.disabled = true; elements.capabilityFieldset.disabled = true; elements.runButton.setAttribute("aria-busy", "true");
    await state.inspectionSavePromise;
    if (state.inspectionDirty || !state.selectedInspectionId) throw new Error("Inspection settings are not saved yet.");
    const captured = await captureSelectedInput(state.selectedInspectionId);
    showInferenceSpinner();
    const payload = await api(`/api/runs/${encodeURIComponent(captured.captureId)}/process`, { method: "POST", body: "{}" });
    state.result = payload.result; renderResult();
    const warning = payload.warnings?.[0];
    if (warning) setStatus(`Inspection completed. ${warning.message}`, "warning"); else setStatus("Inspection completed and saved locally.", "success");
  } catch (error) { hideInferenceSpinner(); setStatus(error.message || "Inspection failed.", "error"); }
  finally { state.busy = false; elements.runButton.setAttribute("aria-busy", "false"); renderInspectionEditor(); updateRunState(); }
}

async function saveArtifactRoot() {
  const value = elements.artifactRoot.value.trim();
  try { const payload = await api("/api/artifacts/settings", { method: "PUT", body: JSON.stringify({ root: value || null }) }); elements.artifactRoot.value = payload.artifacts.root; setStatus("Results folder updated.", "success"); }
  catch (error) { setStatus(error.message || "Results folder could not be updated.", "error"); }
}
async function pickArtifactRoot() {
  try { const payload = await api("/api/artifacts/pick-folder", { method: "POST", body: "{}" }); if (payload.selected) { elements.artifactRoot.value = payload.settings.root; setStatus("Results folder updated.", "success"); } }
  catch (error) { setStatus(error.message || "Folder picker is unavailable.", "error"); }
}

const cameraDiscovery = createCameraDiscoveryController({
  button: elements.cameraDiscoverButton,
  spinner: elements.cameraDiscoverySpinner,
  results: elements.cameraDiscoveryResults,
  hostInput: elements.cameraHost,
  portInput: elements.cameraPort,
  api,
  currentContext: () => elements.cameraEditorDialog.open ? `${state.cameraEditorId}:${state.cameraEditorSlot}` : "",
  setEditorMessage: setCameraEditorMessage
});

viewer.bindControls();

function queueInspectionSave() {
  state.inspectionSavePromise = state.inspectionSavePromise.then(() => saveInspectionIfNeeded()).catch((error) => { setStatus(error.message || "Inspection settings could not be saved.", "error"); });
}

for (const button of elements.cameraSlotSelectors.querySelectorAll("[data-camera-slot]")) button.addEventListener("click", () => selectCameraBySlot(button.dataset.cameraSlot));
elements.cameraManagerButton.addEventListener("click", () => setCameraManagerOpen(!state.cameraManagerOpen));
settings.bind();
schedules.bind();
elements.cameraEditorClose.addEventListener("click", closeCameraEditor);
elements.cameraEditorOverlay.addEventListener("click", closeCameraEditor);
elements.cameraEditorDialog.addEventListener("click", event => { if (event.target === elements.cameraEditorDialog) closeCameraEditor(); });
elements.cameraEditorDialog.addEventListener("cancel", event => {
  if (state.cameraEditorBusy) event.preventDefault();
  else cameraDiscovery.cancel();
});
elements.cameraEditorDialog.addEventListener("close", () => {
  cameraDiscovery.cancel();
  clearCameraEditorSecrets();
  resetCameraEditorPresentation();
});
elements.cameraPasswordToggle.addEventListener("click", () => setCameraPasswordVisible(elements.cameraPassword.type === "password"));
elements.cameraPassword.addEventListener("input", () => {
  if (!elements.cameraPassword.value) setCameraPasswordVisible(false);
  syncCameraPasswordToggle();
});
elements.cameraDiscoverButton.addEventListener("click", () => { void cameraDiscovery.discover(); });
elements.cameraForm.addEventListener("submit", event => { void submitCameraEditor(event); });
elements.cameraRefreshButton.addEventListener("click", () => { void refreshConfiguredCameras(); });
elements.calibrationButton.addEventListener("click", () => { void runCalibrationReport(); });
elements.calibrationClose.addEventListener("click", closeCalibrationDialog);
elements.calibrationDialog.addEventListener("click", event => { if (event.target === elements.calibrationDialog) closeCalibrationDialog(); });
elements.calibrationDialog.addEventListener("cancel", event => { if (state.calibrationBusy) event.preventDefault(); });
elements.prompt.addEventListener("input", () => { state.inspectionDirty = true; updateRunState(); });
elements.prompt.addEventListener("blur", () => { if (selectedInspection() || elements.prompt.value.trim()) queueInspectionSave(); });
for (const radio of document.querySelectorAll('input[name="capability"]')) radio.addEventListener("change", () => { state.inspectionDirty = true; updateRunState(); if (selectedInspection() || elements.prompt.value.trim()) queueInspectionSave(); });
elements.artifactRoot.addEventListener("change", saveArtifactRoot);
elements.artifactRoot.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void saveArtifactRoot(); } });
elements.pickFolder.addEventListener("click", pickArtifactRoot);
elements.runButton.addEventListener("click", runPrimaryAction);
elements.fileInput.addEventListener("change", selectInputFile);
elements.fileInput.addEventListener("cancel", restoreInputModeAfterFileCancel);
elements.fileInputMode.addEventListener("click", () => {
  if (elements.fileInputMode.disabled) return;
  state.filePickerPending = true;
  elements.fileInputMode.checked = true;
  syncInputModePresentation({ preserveSource: true });
  elements.fileInput.value = "";
  elements.fileInput.click();
});
for (const radio of document.querySelectorAll('input[name="input-mode"]')) radio.addEventListener("change", () => {
  syncInputModePresentation({ preserveSource: state.filePickerPending && selectedInputMode() === "file" });
});
for (const radio of document.querySelectorAll('input[name="trigger-mode"]')) radio.addEventListener("change", () => {
  if (radio.value === "scheduled" && radio.checked) {
    const onDemand = document.querySelector('input[name="trigger-mode"][value="on-demand"]');
    if (onDemand) onDemand.checked = true;
    schedules.open();
  }
  updateRunState();
});

setInterval(() => {
  if (schedules.isOpen()) void reloadSchedules();
}, 2_000);

setInterval(() => {
  if (selectedInputMode() === "video" || videoSessionActive()) void reloadVideoSession();
}, 1_000);

startConsoleLifecycle({
  onPageHide: () => {
    for (const cameraId of [...state.cameraPreviewUrls.keys()]) releaseCameraPreview(cameraId);
    releaseSelectedFileUrl();
  }
});

void loadInitialState();
