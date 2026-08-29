import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCameraDiscoveryController } from "../web/camera-discovery.js";
import { startConsoleLifecycle } from "../web/lifecycle.js";

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.type = "";
    this.classList = {
      values: new Set(),
      toggle: (name, enabled) => enabled ? this.classList.values.add(name) : this.classList.values.delete(name),
      contains: (name) => this.classList.values.has(name)
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  replaceChildren(...children) { this.children = [...children]; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() { this.listeners.get("click")?.({ target: this }); }
}

function discoveryFixture({ api, currentContext = () => "new:1" } = {}) {
  const button = new FakeElement("button");
  const spinner = new FakeElement("span");
  const results = new FakeElement("div");
  const hostInput = new FakeElement("input");
  const portInput = new FakeElement("input");
  const editorMessages = [];
  const warnings = [];
  const controller = createCameraDiscoveryController({
    button,
    spinner,
    results,
    hostInput,
    portInput,
    api,
    currentContext,
    setEditorMessage: (message) => editorMessages.push(message),
    createElement: (tag) => new FakeElement(tag),
    logWarning: (message) => warnings.push(message)
  });
  return { button, spinner, results, hostInput, portInput, editorMessages, warnings, controller };
}

test("Image on-demand UI keeps Input as camera feed and does not display the inference capture", async () => {
  const [appSource, viewerSource] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/viewer.js", import.meta.url), "utf8")
  ]);

  const captureStart = appSource.indexOf("async function captureInspection");
  const captureEnd = appSource.indexOf("\n\nfunction runPrimaryAction", captureStart);
  const captureBlock = captureStart >= 0 && captureEnd > captureStart ? appSource.slice(captureStart, captureEnd) : "";
  assert.ok(captureBlock, "captureInspection implementation must remain discoverable to the UI contract test");
  assert.equal(appSource.includes('createMedia("source", captured'), false, "captured inference still must never replace the Input feed");
  assert.equal(appSource.includes("captured.url"), false, "the browser must not create a display URL for the inference capture");
  assert.equal(captureBlock.includes("response.blob()"), false, "Image on-demand capture must not transfer captured image bytes into the Console");
  assert.match(captureBlock, /api\("\/api\/runs\/capture"[\s\S]*captureId/u, "Capture transport should return only an opaque capture id to the Console");
  assert.equal(viewerSource.includes('createMedia("source", url)'), false, "result rendering must never write into the Input pane");
  assert.equal(viewerSource.includes("fallbackUrl"), false, "the inference spinner must not stage the captured still into Result");
  assert.match(appSource, /showInferenceSpinner\(\);[\s\S]*\/process[\s\S]*state\.result = payload\.result; renderResult\(\);/u,
    "Result should remain in place during inference and render only after Process completes");
});

test("File input stays browser-local until Capture & Inspect and uses the existing process boundary", async () => {
  const [html, css, appSource] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.css", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /value="image"[\s\S]*value="video"[\s\S]*value="file"/u);
  assert.match(html, /id="file-input"[^>]*accept="image\/jpeg,image\/png,\.jpg,\.jpeg,\.png"/u);
  assert.match(css, /\.left-mode-stack \.input-mode-row\s*\{\s*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/u);

  const selectionStart = appSource.indexOf("function selectInputFile");
  const selectionEnd = appSource.indexOf("\n\nasync function captureFileInspection", selectionStart);
  const selectionBlock = appSource.slice(selectionStart, selectionEnd);
  assert.ok(selectionBlock);
  assert.match(selectionBlock, /URL\.createObjectURL\(file\)/u, "selected File should be displayed from the original browser File object");
  assert.equal(selectionBlock.includes("api("), false, "selecting a File must not upload or normalize it");
  assert.equal(selectionBlock.includes("FileReader"), false);
  assert.equal(selectionBlock.includes("createImageBitmap"), false);
  assert.equal(selectionBlock.includes("canvas"), false);

  const captureStart = appSource.indexOf("async function captureFileInspection");
  const captureEnd = appSource.indexOf("\n\nfunction setCameraStatus", captureStart);
  const captureBlock = appSource.slice(captureStart, captureEnd);
  assert.match(captureBlock, /api\("\/api\/runs\/file"[\s\S]*body: file/u);
  assert.match(appSource, /selectedInputMode\(\) === "file"[\s\S]*captureFileInspection/u);
  assert.match(appSource, /scheduledRadio\.disabled = locked \|\| videoMode \|\| fileMode/u);
  assert.match(appSource, /fileMode[\s\S]*state\.selectedFile[\s\S]*state\.moondream\?\.configured/u);
  assert.match(appSource, /const captured = await captureSelectedInput\(state\.selectedInspectionId\)/u);
});

test("File picker selects File immediately, preserves Input while open, and cancel restores the last non-File mode", async () => {
  const appSource = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(appSource, /lastNonFileInputMode: "image", filePickerPending: false/u);
  assert.match(appSource, /if \(inputMode === "image" \|\| inputMode === "video"\) state\.lastNonFileInputMode = inputMode/u,
    "Image and Video changes should remember the latest non-File input mode");

  const pickerStart = appSource.indexOf('elements.fileInputMode.addEventListener("click"');
  const pickerEnd = appSource.indexOf("\n});", pickerStart) + 4;
  const pickerBlock = pickerStart >= 0 && pickerEnd > pickerStart ? appSource.slice(pickerStart, pickerEnd) : "";
  assert.ok(pickerBlock, "File picker click flow must remain discoverable");
  assert.equal(pickerBlock.includes("preventDefault"), false,
    "File radio activation must not be cancelled before the picker opens");
  assert.match(pickerBlock, /filePickerPending = true;[\s\S]*fileInputMode\.checked = true;[\s\S]*syncInputModePresentation\(\{ preserveSource: true \}\);[\s\S]*fileInput\.click\(\)/u,
    "File must become selected before the picker opens without replacing the current Input media");
  assert.equal(pickerBlock.includes("renderSelectedFileSource"), false,
    "Opening the picker must not render a File placeholder or previously selected file");
  assert.equal(pickerBlock.includes("refreshSelectedCameraPreview"), false,
    "Opening the picker must not refresh or replace the current camera image");

  assert.match(appSource, /fileInput\.addEventListener\("cancel", restoreInputModeAfterFileCancel\)/u);
  assert.match(appSource, /function restoreInputModeAfterFileCancel\(\)[\s\S]*filePickerPending = false[\s\S]*lastNonFileInputMode === "video" \? "video" : "image"[\s\S]*radio\.checked = true;[\s\S]*syncInputModePresentation\(\{ preserveSource: true \}\)/u,
    "Cancelling must restore the most recently selected Image or Video mode without replacing the Input media");
  assert.match(appSource, /syncInputModePresentation\(\{ preserveSource: state\.filePickerPending && selectedInputMode\(\) === "file" \}\)/u,
    "The File radio change event must also preserve Input while the native picker is pending");
  assert.match(appSource, /visibleSourceKind: ""/u,
    "Input chrome must track the source actually rendered, not the temporarily selected File radio");
  assert.match(appSource, /function renderCameraSelectors\(\)[\s\S]*visibleSourceKind === "file"[\s\S]*cameraSlotSelectors\.hidden = displayingFile/u,
    "camera selectors must remain visible while a camera is still the rendered Input source");
  assert.match(appSource, /function renderCameraAlias\(\)[\s\S]*visibleSourceKind === "file"/u,
    "camera alias visibility must follow rendered media rather than File-picker state");
  assert.match(appSource, /cameraStatus\.hidden = state\.visibleSourceKind === "file"/u,
    "camera status must remain unchanged until a File image is actually rendered");

  const selectionStart = appSource.indexOf("function selectInputFile");
  const selectionEnd = appSource.indexOf("\n\nfunction syncInputModePresentation", selectionStart);
  const selectionBlock = selectionStart >= 0 && selectionEnd > selectionStart ? appSource.slice(selectionStart, selectionEnd) : "";
  assert.match(selectionBlock, /filePickerPending = false[\s\S]*URL\.createObjectURL\(file\)[\s\S]*renderSelectedFileSource\(\)/u,
    "Only an actual valid file selection should replace Input with the selected image");
});

test("stale selected-camera preview failures cannot overwrite a newer camera status", async () => {
  const appSource = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("async function refreshSelectedCameraPreview()");
  const end = appSource.indexOf("\n\nfunction selectCameraBySlot", start);
  const block = start >= 0 && end > start ? appSource.slice(start, end) : "";
  assert.ok(block, "selected-camera preview implementation must remain discoverable");
  assert.match(block, /catch \(error\) \{\s*if \(sequence === state\.cameraSourcePreviewSequence && cameraId === state\.selectedCameraId\) \{\s*setCameraStatus\("no-camera"\);/u,
    "only the current selected-camera preview request may change status to No Camera after a failure");
});

test("Camera Manager Refresh retries the configured cameras without restarting the app", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /class="camera-manager-topbar">[\s\S]*class="camera-manager-heading">[\s\S]*CAMERAS[\s\S]*id="camera-manager-message"[^>]*aria-live="polite"[\s\S]*id="camera-refresh-indicator"[\s\S]*class="camera-manager-calibration-button camera-manager-refresh-button" id="camera-refresh-button">Refresh<\/button>/u,
    "Camera Manager messages must live beside CAMERAS in the top bar, while Refresh stays at the top-right with its status indicator");
  assert.doesNotMatch(html, /<\/div>\s*<div class="camera-manager-message" id="camera-manager-message"/u,
    "Camera Manager must never render a separate message row below its header");
  assert.match(appSource, /cameraRefreshButton: \$\("#camera-refresh-button"\)/u);
  assert.match(appSource, /cameraRefreshIndicator: \$\("#camera-refresh-indicator"\)/u);
  assert.match(appSource, /function setCameraRefreshIndicator\(mode = "idle"\)[\s\S]*camera-action-spinner active[\s\S]*createLucideIcon\("check"\)[\s\S]*1500/u,
    "Refresh feedback should transition from the existing grey spinner to a temporary Lucide check");
  assert.match(appSource, /async function refreshConfiguredCameras\(\)[\s\S]*setCameraRefreshIndicator\("loading"\)[\s\S]*await reloadCameras\(preferredId, \{ refreshPreviews: false \}\);[\s\S]*await refreshCameraManagerPreviews\(\)[\s\S]*showSuccessCheck = true[\s\S]*setCameraRefreshIndicator\(state\.cameraManagerOpen && showSuccessCheck \? "success" : "idle"\)/u,
    "Refresh should reload saved camera configuration, await reconnect attempts, and show the temporary check only on full success while Camera Management is still open");
  assert.equal(appSource.includes("Configured cameras refreshed."), false,
    "successful Refresh should use the temporary check instead of a success message");
  assert.equal(appSource.includes("Refreshing configured cameras…"), false,
    "Refresh progress should be represented only by the spinner, not a text message");
  assert.match(appSource, /await reloadCameras\(preferredId, \{ refreshPreviews: false \}\);\s*if \(!state\.cameraManagerOpen\) return;[\s\S]*await refreshCameraManagerPreviews\(\);\s*if \(!state\.cameraManagerOpen\) return;/u,
    "closing Camera Management during Refresh must suppress late preview/status feedback");
  assert.match(appSource, /setCameraRefreshIndicator\(state\.cameraManagerOpen && showSuccessCheck \? "success" : "idle"\)/u,
    "a completed Refresh must not resurrect a success check after Camera Management was closed");
  assert.match(appSource, /state\.draggedCameraId = "";\s*setCameraManagerMessage\(\);\s*setCameraRefreshIndicator\("idle"\)/u,
    "closing Camera Management must clear any in-flight Refresh indicator immediately");
  assert.match(appSource, /cameraRefreshButton\.addEventListener\("click", \(\) => \{ void refreshConfiguredCameras\(\); \}\)/u);
});

test("Calibration evaluates the exact media currently rendered in Input", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /class="camera-manager-help"><span>Drag the thumbnails to rearrange the cameras\.<\/span><\/div>[\s\S]*id="calibration-button"[^>]*>Calibration<\/button>/u,
    "the drag hint should keep its original under-grid location while Calibration is a separate Camera Management control");
  assert.match(html, /id="calibration-dialog"[\s\S]*id="calibration-report"/u,
    "Calibration guidance should render in its own secondary modal");
  assert.match(html, /class="calibration-title-row"><h2 id="calibration-title">Calibration Report<\/h2><span class="camera-action-spinner calibration-spinner" id="calibration-spinner"/u,
    "the calibration loading state should reuse the Camera Manager spinner beside the modal title");
  assert.match(appSource, /calibrationSpinner: \$\("#calibration-spinner"\)/u);
  assert.match(appSource, /state\.calibrationBusy = true;\s*elements\.calibrationSpinner\.classList\.add\("active"\)/u);
  assert.match(appSource, /state\.calibrationBusy = false;\s*elements\.calibrationSpinner\.classList\.remove\("active"\)/u);
  assert.equal(html.includes('id="camera-calibration-button"'), false,
    "Calibration must not remain owned by an edited camera");
  assert.match(appSource, /setCalibrationMessage\("This report evaluates the image currently shown in Input\."\);/u,
    "Calibration completion text should be the concise current-Input explanation without success-tone styling");
  assert.equal(appSource.includes("Calibration report updated from the current Input image."), false);
  assert.equal(appSource.includes("Informational only. This report evaluates the exact image currently shown in Input and never blocks inspections."), false);
  assert.equal(appSource.includes('title.textContent = "Calibration Report"'), false,
    "the report body must not repeat the modal title");
  assert.equal(appSource.includes("calibration-report-heading"), false,
    "the redundant inner report heading section must be removed");

  assert.match(appSource, /visibleSourceBlob: null, visibleSourceMimeType: "", visibleSourceKind: "", calibrationBusy: false/u);
  assert.match(appSource, /function setVisibleSource\(blob, mimeType, url, kind\)[\s\S]*visibleSourceBlob = blob[\s\S]*visibleSourceKind = kind[\s\S]*createMedia\("source", url\)/u,
    "the media shown in Input must be the authoritative calibration source");
  assert.match(appSource, /setVisibleSource\(state\.selectedFile, state\.selectedFileMimeType, state\.selectedFileUrl, "file"\)/u,
    "a selected File image must become the visible calibration source");
  assert.match(appSource, /setVisibleSource\(blob, blob\.type \|\| response\.headers\.get\("content-type"\) \|\| "image\/jpeg", url, "camera"\)/u,
    "the selected camera preview bytes must become the visible calibration source");
  assert.match(appSource, /const source = state\.visibleSourceBlob;[\s\S]*api\("\/api\/calibration"[\s\S]*body: source/u,
    "Calibration must upload the already-visible source bytes instead of asking the service to capture another camera frame");
  assert.match(appSource, /if \(state\.calibrationBusy\) \{[\s\S]*URL\.revokeObjectURL\(url\)[\s\S]*return;[\s\S]*\}/u,
    "an in-flight selected-camera preview must not replace Input after calibration has started");
  assert.match(appSource, /sourceUrl && sourceBlob && selectedInputMode\(\) !== "file" && !state\.calibrationBusy/u,
    "camera-manager preview refresh must not replace the visible calibration source while calibration is running");
  assert.equal(appSource.includes("/calibrate`"), false,
    "the Console must not retain the old camera-specific calibration endpoint");
});

test("Video helper text is shown only for Video input", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="video-format-help" hidden>Samples at 4 fps · runs until Stop<\/span>/u);
  assert.match(appSource, /videoFormatHelp: \$\("#video-format-help"\)/u);
  assert.match(appSource, /elements\.videoFormatHelp\.hidden = inputMode !== "video"/u);
});

test("Scheduled opens a Settings-style modal with independent tasks and no inline layout card", async () => {
  const [html, css, appSource, scheduleSource] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.css", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/schedules.js", import.meta.url), "utf8")
  ]);

  assert.equal(html.includes('id="schedule-controls"'), false, "Scheduled controls must not expand the main Console");
  assert.match(html, /class="settings-dialog scheduled-tasks-dialog" id="scheduled-tasks-dialog"/u,
    "Scheduled tasks should reuse the Settings modal visual language");
  assert.match(html, /id="schedule-count">0 of 10 scheduled tasks/u);
  assert.match(html, /id="schedule-camera"[\s\S]*id="schedule-capability"[\s\S]*id="schedule-prompt"/u);
  assert.match(html, /id="scheduled-task-list"/u);
  assert.match(css, /\.scheduled-tasks-dialog\s*\{[\s\S]*width:min\(760px,calc\(100vw - 32px\)\)/u);
  assert.match(css, /\.scheduled-task-row\s*\{[\s\S]*grid-template-columns:minmax\(0,1fr\) auto/u);

  assert.match(appSource, /radio\.value === "scheduled" && radio\.checked[\s\S]*onDemand\.checked = true;[\s\S]*schedules\.open\(\)/u,
    "Scheduled mode should launch the modal without leaving the main Console in a layout-changing scheduled state");
  assert.match(scheduleSource, /method: editingId \? "PUT" : "POST"/u);
  assert.match(scheduleSource, /method: "PATCH"[\s\S]*JSON\.stringify\(\{ enabled \}\)/u);
  assert.match(scheduleSource, /method: "DELETE"/u);
  assert.match(scheduleSource, /schedule\.enabled \? "Disarm" : "Arm"/u);
  assert.match(scheduleSource, /actionButton\("Edit"/u);
  assert.match(scheduleSource, /actionButton\("Delete"/u);
  assert.equal(scheduleSource.includes("inspectionId"), false,
    "Scheduled task UI must own its prompt/capability rather than reuse the mutable Console inspection");
});

test("Detect presentation uses the requested object label and count without inventing confidence", async () => {
  const [viewerSource, css] = await Promise.all([
    readFile(new URL("../web/viewer.js", import.meta.url), "utf8"),
    readFile(new URL("../web/app.css", import.meta.url), "utf8")
  ]);
  assert.match(viewerSource, /const label = result\.prompt\?\.trim\(\) \|\| "object"/u);
  assert.match(viewerSource, /resultCapability\.textContent = `\$\{count\} detected · \$\{label\}`/u);
  assert.match(viewerSource, /tag\.className = "detection-label"[\s\S]*tag\.textContent = label/u);
  assert.equal(/confidence|probability/u.test(viewerSource.slice(viewerSource.indexOf("function spatialOverlay"), viewerSource.indexOf("function transformLayer"))), false,
    "Detect presentation must not invent confidence/probability values that Moondream does not return");
  assert.match(css, /\.detection-label[\s\S]*background:rgba\(88,217,232,\.94\)/u);
  assert.equal(css.includes(".detection-summary"), false, "Detect count belongs in the existing Result header rather than covering the image");
});

test("Detect renders visible normalized boxes in the live Result overlay", async () => {
  const viewerSource = await readFile(new URL("../web/viewer.js", import.meta.url), "utf8");
  const detectStart = viewerSource.indexOf('result.capability === "detect"');
  const pointStart = viewerSource.indexOf('result.capability === "point"', detectStart);
  const detectBlock = detectStart >= 0 && pointStart > detectStart ? viewerSource.slice(detectStart, pointStart) : "";
  assert.ok(detectBlock, "Detect overlay implementation must remain discoverable");
  assert.match(detectBlock, /stroke: "#000000"[\s\S]*"stroke-opacity": "\.78"[\s\S]*"stroke-width": "\.008"/u);
  assert.match(detectBlock, /stroke: "#58d9e8"[\s\S]*"stroke-width": "\.004"/u);
  assert.equal(detectBlock.includes('"vector-effect": "non-scaling-stroke"'), false,
    "Normalized Detect stroke widths must scale through the 0..1 SVG viewBox instead of collapsing to subpixel non-scaling strokes");
});

test("Result spinner hides only the empty placeholder and Segment uses a high-contrast live mask", async () => {
  const viewerSource = await readFile(new URL("../web/viewer.js", import.meta.url), "utf8");
  assert.match(viewerSource, /const emptyState = resultViewport\.querySelector\("\.empty-state"\);[\s\S]*emptyState\.hidden = true/u,
    "Processing should hide the empty Result placeholder while preserving an existing result surface");
  assert.match(viewerSource, /function hideInferenceSpinner\(\)[\s\S]*emptyState\.hidden = false/u,
    "A failed inference should restore the empty Result placeholder after the spinner is removed");
  assert.match(viewerSource, /result\.capability === "segment"[\s\S]*fill: "#58d9e8"[\s\S]*"fill-opacity": "\.38"[\s\S]*stroke: "#7ce8f2"/u,
    "Segment masks should use a visible cyan fill/stroke instead of low-opacity red-on-red rendering");
  assert.match(viewerSource, /stroke: "#000000"[\s\S]*"stroke-opacity": "\.78"[\s\S]*"stroke-width": "\.010"/u,
    "Segment boundaries should include a dark halo so the mask remains visible on bright imagery");
});

test("Video mode has no policy/status/counter card in the Console", async () => {
  const [html, appSource, videoSource] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/video.js", import.meta.url), "utf8")
  ]);
  assert.equal(html.includes('id="video-controls"'), false);
  assert.equal(html.includes('id="video-policy"'), false);
  assert.equal(html.includes('id="video-status"'), false);
  assert.equal(html.includes('id="video-summary"'), false);
  assert.equal(appSource.includes("videoPolicy"), false);
  assert.equal(videoSource.includes("formatDuration"), false);
});

test("camera discovery owns only its button/spinner and renders selectable host rows", async () => {
  let resolveDiscovery;
  const fixture = discoveryFixture({ api: () => new Promise((resolve) => { resolveDiscovery = resolve; }) });
  const pending = fixture.controller.discover();
  assert.equal(fixture.controller.isBusy(), true);
  assert.equal(fixture.button.disabled, true);
  assert.equal(fixture.button.getAttribute("aria-busy"), "true");
  assert.equal(fixture.spinner.classList.contains("active"), true);
  assert.equal(fixture.results.children[0].textContent, "Discovering available cameras…");

  resolveDiscovery({ cameras: [{ host: "192.168.1.50", discoveryPort: 2020 }] });
  await pending;
  assert.equal(fixture.controller.isBusy(), false);
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.spinner.classList.contains("active"), false);
  assert.equal(fixture.results.children.length, 1);
  const row = fixture.results.children[0];
  assert.equal(row.children[0].textContent, "192.168.1.50");
  assert.equal(row.children[1].textContent, "Select");

  row.click();
  assert.equal(fixture.hostInput.value, "192.168.1.50");
  assert.equal(fixture.portInput.value, "", "ONVIF/discovery service ports must not populate the RTSP port field");
  assert.deepEqual(fixture.editorMessages, ["Enter the camera Username and Password."]);
});

test("camera discovery ignores a stale response after cancellation", async () => {
  let resolveDiscovery;
  const fixture = discoveryFixture({ api: () => new Promise((resolve) => { resolveDiscovery = resolve; }) });
  const pending = fixture.controller.discover();
  fixture.controller.cancel();
  resolveDiscovery({ cameras: [{ host: "10.0.0.9", discoveryPort: 2020 }] });
  await pending;
  assert.equal(fixture.controller.isBusy(), false);
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.results.children.some((child) => child.children?.[0]?.textContent === "10.0.0.9:554"), false);
});

test("camera discovery keeps internal Camsnap diagnostics out of user-facing results", async () => {
  const fixture = discoveryFixture({
    api: async () => { throw new Error("Camsnap is not available. Run Doctor for executable diagnostics."); }
  });
  await fixture.controller.discover();
  assert.equal(fixture.results.children.length, 1);
  assert.equal(fixture.results.children[0].textContent, "Camera discovery is unavailable. You can enter Host / IP manually.");
  assert.deepEqual(fixture.editorMessages, []);
  assert.deepEqual(fixture.warnings, ["Camsnap is not available. Run Doctor for executable diagnostics."]);
});

test("Console lifecycle restarts its heartbeat after pageshow and releases on pagehide", async () => {
  const listeners = new Map();
  const fetchCalls = [];
  const beacons = [];
  const intervals = [];
  const cleared = [];
  let pageHideCalls = 0;
  const windowRef = { addEventListener: (type, listener) => listeners.set(type, listener) };
  const lifecycle = startConsoleLifecycle({
    sessionId: "tab-test",
    fetchImpl: async (path, options) => { fetchCalls.push([path, options.method]); return { ok: true }; },
    navigatorRef: { sendBeacon: (path) => { beacons.push(path); return true; } },
    windowRef,
    setIntervalImpl: (callback, ms) => { intervals.push([callback, ms]); return intervals.length; },
    clearIntervalImpl: (id) => cleared.push(id),
    onPageHide: () => { pageHideCalls += 1; }
  });
  await Promise.resolve();
  assert.equal(lifecycle.sessionId, "tab-test");
  assert.deepEqual(fetchCalls[0], ["/api/console/session/tab-test/heartbeat", "POST"]);
  assert.equal(intervals[0][1], 1_500);

  listeners.get("pagehide")();
  assert.deepEqual(cleared, [1]);
  assert.deepEqual(beacons, ["/api/console/session/tab-test/release"]);
  assert.equal(pageHideCalls, 1);

  listeners.get("pageshow")();
  await Promise.resolve();
  assert.equal(fetchCalls.filter(([path]) => path.endsWith("/heartbeat")).length, 2);
  assert.equal(intervals.length, 2);
});
