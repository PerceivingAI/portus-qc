import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { loadAppConfig } from "../../config/load.ts";
import { assertLoopbackHost, createPortusQcHttpServer, startPortusQcService } from "../src/server.ts";

async function startEphemeralServer() {
  const { server, startedAt } = createPortusQcHttpServer({ startedAt: "2026-08-27T00:00:00.000Z" });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    startedAt,
    url: `http://127.0.0.1:${address.port}`
  };
}

test("health route reports local service readiness without configuration secrets", async (t) => {
  const running = await startEphemeralServer();
  t.after(() => new Promise((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`${running.url}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.deepEqual(payload, {
    status: "ok",
    service: "portus-qc",
    local: true,
    startedAt: "2026-08-27T00:00:00.000Z"
  });
  assert.equal(JSON.stringify(payload).includes("apiKey"), false);
});

test("doctor route serializes injected diagnostics and does not own runtime probing", async (t) => {
  const report = {
    status: "degraded",
    checkedAt: "2026-08-27T00:00:00.000Z",
    checks: [{ id: "moondream", label: "Moondream", status: "attention", message: "Moondream API key is not configured yet.", details: { configured: false } }]
  };
  const { server } = createPortusQcHttpServer({
    startedAt: "2026-08-27T00:00:00.000Z",
    runDoctor: async () => report
  });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/doctor`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), report);

  const wrongMethod = await fetch(`http://127.0.0.1:${address.port}/api/doctor`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
});

test("Console lifecycle routes heartbeat and release only same-origin local sessions", async (t) => {
  const calls = [];
  const consoleLifecycle = {
    heartbeat(sessionId) { calls.push(["heartbeat", sessionId]); },
    release(sessionId) { calls.push(["release", sessionId]); },
    stop() {}
  };
  const { server } = createPortusQcHttpServer({ consoleLifecycle });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;

  const heartbeat = await fetch(`${url}/api/console/session/tab_123/heartbeat`, { method: "POST" });
  assert.equal(heartbeat.status, 200);
  assert.deepEqual(await heartbeat.json(), { ok: true });

  const release = await fetch(`${url}/api/console/session/tab_123/release`, { method: "POST" });
  assert.equal(release.status, 200);
  assert.deepEqual(calls, [["heartbeat", "tab_123"], ["release", "tab_123"]]);

  const wrongMethod = await fetch(`${url}/api/console/session/tab_123/heartbeat`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const crossOrigin = await fetch(`${url}/api/console/session/tab_123/heartbeat`, {
    method: "POST",
    headers: { origin: "http://example.test" }
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(calls.length, 2);
});

test("root and transport errors remain thin HTTP behavior", async (t) => {
  const running = await startEphemeralServer();
  t.after(() => new Promise((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve())));

  const root = await fetch(running.url);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-security-policy"), /default-src 'self'/u);
  const html = await root.text();
  assert.match(html, /Camera \/ Source/u);
  assert.match(html, /<header class="app-bar">\s*<h1><span class="app-title-accent">Portus<\/span>QC<\/h1>/u);
  assert.match(html, /id="camera-manager-button"[^>]*aria-label="Manage cameras"[^>]*><span data-lucide="grid-2x2"><\/span>/u);
  assert.match(html, /id="settings-button"[^>]*aria-label="Open settings"[^>]*><span data-lucide="settings"><\/span>/u);
  assert.match(html, /id="camera-alias"[^>]*hidden/u);
  assert.match(html, /id="camera-slot-selectors"/u);
  for (const slot of [1, 2, 3, 4]) assert.match(html, new RegExp(`data-camera-slot="${slot}"`, "u"));
  assert.match(html, /id="camera-manager"[^>]*hidden/u);
  assert.match(html, /id="camera-slots"/u);
  assert.match(html, /class="panel-kicker camera-manager-label">CAMERAS<\/span>/u);
  assert.match(html, /Drag the thumbnails to rearrange the cameras\./u);
  assert.match(html, /class="camera-manager-help"><span>Drag the thumbnails to rearrange the cameras\.<\/span><\/div>/u);
  assert.ok(html.indexOf('id="calibration-button"') > html.indexOf('class="camera-manager-help"'));
  assert.match(html, /class="camera-manager-heading">[\s\S]*class="panel-kicker camera-manager-label">CAMERAS<\/span>[\s\S]*id="camera-manager-message"[^>]*aria-live="polite"[\s\S]*<\/div>\s*<div class="camera-manager-refresh-action">/u);
  assert.doesNotMatch(html, /<\/div>\s*<div class="camera-manager-message" id="camera-manager-message"/u);
  assert.match(html, /id="result-panel-header"/u);
  assert.doesNotMatch(html, /<h3>Manage Cameras<\/h3>/u);
  assert.doesNotMatch(html, /Portus QC supports four camera slots\. Drag a configured camera to rearrange it\./u);

  assert.match(html, /id="settings-dialog"[^>]*aria-labelledby="settings-title"/u);
  assert.match(html, /<h2 id="settings-title">Settings<\/h2>/u);
  assert.match(html, /class="inference-settings"[^>]*aria-label="Moondream settings"/u);
  assert.doesNotMatch(html, /<span class="settings-kicker">PORTUS QC<\/span>/u);
  assert.doesNotMatch(html, /<span class="settings-kicker">INFERENCE<\/span>/u);
  assert.doesNotMatch(html, /<h3>Moondream<\/h3>/u);
  assert.doesNotMatch(html, /id="moondream-state"/u);
  assert.match(html, /id="moondream-model"[^>]*maxlength="200"/u);
  assert.doesNotMatch(html, /id="moondream-model"[^>]*readonly/u);
  assert.match(html, /<label for="moondream-api-key">API Key<\/label>/u);
  assert.match(html, /id="moondream-api-key"[^>]*type="password"[^>]*placeholder="Your API Key"/u);
  assert.match(html, /id="moondream-api-key-toggle"[^>]*aria-label="Show API Key"[^>]*aria-pressed="false"[^>]*><span data-lucide="eye"><\/span>/u);
  assert.doesNotMatch(html, /secret-icon/u);
  assert.match(html, /id="moondream-save"[^>]*>Save<\/button>/u);
  assert.doesNotMatch(html, /id="moondream-remove"/u);
  assert.doesNotMatch(html, /id="moondream-test"/u);

  assert.match(html, /id="camera-editor-overlay"[^>]*hidden/u);
  assert.match(html, /id="camera-editor-dialog"[^>]*aria-label="Camera editor"/u);
  assert.match(html, /id="camera-editor-kicker">ADD CAMERA 1<\/span>/u);
  assert.doesNotMatch(html, /id="camera-editor-title"/u);
  assert.doesNotMatch(html, />Add camera<\/h2>/u);
  assert.match(html, /id="camera-discover-button"[^>]*>Discover Available Cameras<\/button>/u);
  assert.match(html, /id="camera-discovery-spinner" aria-hidden="true"/u);
  assert.ok(html.indexOf('id="camera-discovery-spinner"') < html.indexOf('id="camera-discover-button"'));
  assert.match(html, /id="camera-discovery-results"/u);
  assert.doesNotMatch(html, />Find camera</u);
  assert.doesNotMatch(html, /Camsnap discovery is the primary setup path\./u);
  assert.doesNotMatch(html, /Select Discover Cameras, or enter the host\/IP manually if discovery does not find it\./u);
  assert.match(html, /id="camera-alias-input"/u);
  assert.match(html, /id="camera-host"/u);
  assert.match(html, /id="camera-username"/u);
  assert.match(html, /id="camera-password"[^>]*type="password"/u);
  assert.match(html, /id="camera-password-toggle"[^>]*aria-label="Show Password"[^>]*aria-pressed="false"[^>]*><span data-lucide="eye"><\/span>/u);
  assert.match(html, /<div class="credential-heading"><strong>Camera Credentials<\/strong><\/div>/u);
  assert.doesNotMatch(html, /Camera-local credentials/u);
  assert.match(html, /class="camera-password-help" id="camera-credential-help">Use RTSP\/Camera Account Username and Password\.<\/span>/u);
  assert.ok(html.indexOf('id="camera-credential-help"') < html.indexOf('class="camera-preparation"'));
  assert.match(html, /id="camera-connect-spinner" aria-hidden="true"/u);
  assert.ok(html.indexOf('id="camera-connect-spinner"') < html.indexOf('id="camera-connect-button"'));
  assert.doesNotMatch(html, /button-spinner/u);
  assert.match(html, /id="camera-connect-button"/u);
  assert.match(html, /Some cameras need to be reset after/u);
  assert.match(html, /multiple connection attempts\./u);
  assert.ok(html.indexOf('id="camera-connect-button"') < html.indexOf('class="advanced-settings"'));
  assert.ok(html.indexOf('class="advanced-settings"') < html.indexOf('class="camera-discovery-block"'));
  assert.match(html, /<details class="camera-preparation">\s*<summary>How to get the RTSP\/Camera Account Username and Password:<\/summary>/u);
  assert.doesNotMatch(html, /<details class="camera-preparation" open>/u);
  assert.doesNotMatch(html, /How do I prepare my camera\?/u);
  assert.doesNotMatch(html, /<div class="camera-preparation-body">\s*<p>How to get the RTSP\/Camera Account Username and Password:<\/p>/u);
  assert.match(html, /Log into the IP Camera's app\./u);
  assert.match(html, /Select the camera you want to configure\./u);
  assert.match(html, /Go to Settings\/Advanced Settings\./u);
  assert.match(html, /Turn on Camera Account and create a Username and Password \(These are separate from the app's credentials\)\./u);
  assert.match(html, /Reset your Camera\./u);
  assert.doesNotMatch(html, /camera-local RTSP\/Camera Account/u);
  assert.doesNotMatch(html, /id="camera-credential-state"/u);
  assert.match(html, /Advanced Camsnap settings/u);
  assert.doesNotMatch(html, /id="camera-calibration-button"/u);
  assert.match(html, /id="calibration-button"[^>]*>Calibration<\/button>/u);
  assert.match(html, /id="calibration-dialog"[^>]*aria-labelledby="calibration-title"/u);
  assert.match(html, /id="calibration-report"[^>]*hidden/u);
  assert.doesNotMatch(html, /id="camera-select"/u);
  assert.doesNotMatch(html, /id="camera-id"/u);
  assert.doesNotMatch(html, /id="camera-add-button"/u);
  assert.doesNotMatch(html, /id="camera-test-button"/u);

  assert.match(html, /Capture &amp; Inspect/u);
  assert.doesNotMatch(html, /id="run-button"[^>]*>[^<]*<span[^>]*class="[^"]*spinner/u);
  assert.doesNotMatch(html, /class="run-icon"/u);
  assert.match(html, /data-action="zoom-out"[^>]*><span data-lucide="minus"><\/span>/u);
  assert.match(html, /data-action="zoom-in"[^>]*><span data-lucide="plus"><\/span>/u);
  assert.match(html, /data-action="fullscreen"[^>]*><span data-lucide="maximize-2"><\/span>/u);
  assert.match(html, /id="pick-folder"[^>]*><span data-lucide="folder-open"><\/span>/u);
  assert.match(html, /class="dialog-close"[^>]*><span data-lucide="x"><\/span>/u);
  assert.doesNotMatch(html, /[⚙▦▣⛶×]/u);
  assert.match(html, /class="control-columns"/u);
  assert.match(html, /<legend>Input<\/legend>/u);
  assert.match(html, /name="input-mode" value="video"/u);
  assert.match(html, /name="input-mode" value="file"/u);
  assert.match(html, /id="file-input"[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,\.jpg,\.jpeg,\.png"[^>]*hidden/u);
  assert.doesNotMatch(html, /name="input-mode" value="video" disabled/u);
  assert.doesNotMatch(html, /id="video-controls"/u);
  assert.doesNotMatch(html, /id="video-policy"/u);
  assert.doesNotMatch(html, /id="video-status"/u);
  assert.doesNotMatch(html, /id="video-summary"/u);
  assert.match(html, /<legend>Mode<\/legend>/u);
  assert.match(html, /name="trigger-mode" value="scheduled"/u);
  assert.doesNotMatch(html, /name="trigger-mode" value="scheduled"[^>]*disabled/u);
  assert.doesNotMatch(html, /id="schedule-controls"/u);
  assert.match(html, /id="scheduled-tasks-dialog"[^>]*aria-labelledby="scheduled-tasks-title"/u);
  assert.match(html, /id="schedule-form"/u);
  assert.match(html, /id="schedule-camera"/u);
  assert.match(html, /id="schedule-capability"/u);
  assert.match(html, /id="schedule-prompt"[^>]*maxlength="4000"/u);
  assert.match(html, /id="schedule-interval-value"/u);
  assert.match(html, /id="schedule-interval-unit"/u);
  assert.match(html, /id="schedule-enabled"[^>]*type="checkbox"/u);
  assert.match(html, /id="scheduled-task-list"/u);
  assert.match(html, /id="schedule-count">0 of 10 scheduled tasks/u);
  assert.doesNotMatch(html, /id="schedule-next"/u);
  assert.doesNotMatch(html, /id="schedule-last"/u);
  assert.match(html, /<legend>Capability<\/legend>/u);
  assert.match(html, />Results folder<\/label>/u);
  assert.match(html, />Prompt<\/label>/u);
  assert.match(html, /value="query"/u);
  assert.match(html, /value="detect"/u);
  assert.match(html, /value="segment"/u);
  assert.match(html, /value="point"/u);
  assert.match(html, /value="caption"/u);
  assert.doesNotMatch(html, /id="inspection-select"/u);
  assert.doesNotMatch(html, /id="save-state"/u);
  assert.doesNotMatch(html, /id="status-line"/u);

  const detectIndex = html.indexOf('value="detect"');
  const segmentIndex = html.indexOf('value="segment"');
  const pointIndex = html.indexOf('value="point"');
  const captionIndex = html.indexOf('value="caption"');
  const queryIndex = html.indexOf('value="query"');
  assert.ok(detectIndex < segmentIndex && segmentIndex < pointIndex && pointIndex < captionIndex && captionIndex < queryIndex);

  const css = await fetch(`${running.url}/assets/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/u);
  const cssRaw = await css.text();
  const cssText = cssRaw.replace(/\s+/gu, " ").replace(/\s*([{}:;,>])\s*/gu, "$1").trim();
  assert.match(cssText, /\.visual-grid/u);
  assert.match(cssText, /#result-panel\.camera-management-open\{grid-template-rows:minmax\(300px,1fr\) 0\}/u);
  assert.match(cssText, /\.app-bar\{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 14px/u);
  assert.match(cssText, /--font-xs:10px;--font-sm:11px;--font-ui:12px;--font-body:13px;--font-emphasis:14px;--font-heading:15px;--font-dialog:17px/u);
  assert.match(cssText, /--icon-sm:14px;--icon-md:16px;--icon-lg:18px/u);
  assert.match(cssText, /\.app-bar h1\{height:100%;display:flex;align-items:center;margin:0;font-size:var\(--font-heading\)/u);
  assert.match(cssText, /\.app-bar-actions\{height:100%;display:flex;align-items:center/u);
  assert.match(cssText, /\.camera-slot-selectors\{position:absolute;left:50%;top:50%;transform:translate\(-50%,-50%\);[^}]*border:0/u);
  assert.match(cssText, /\.camera-slot-selectors button\{[^}]*border:0[^}]*font-size:var\(--font-body\)/u);
  assert.doesNotMatch(cssText, /\.camera-slot-selectors\{[^}]*border-right:/u);
  assert.match(cssText, /\.camera-manager\{position:relative;display:flex;flex-direction:column/u);
  assert.match(cssText, /\.camera-manager-heading\{min-width:0;flex:1 1 auto;display:flex;align-items:center;gap:10px\}/u);
  assert.match(cssText, /\.camera-manager-message\{min-width:0;margin:0;color:var\(--muted\)/u);
  assert.match(cssText, /\.camera-slots\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(cssText, /\.camera-manager-help\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(cssText, /\.camera-manager-help span\{grid-column:2;width:100%;text-align:right\}/u);
  assert.match(cssText, /\.camera-manager-calibration-button\{align-self:flex-end;flex:0 0 auto;margin-top:auto[^}]*height:28px/u);
  assert.match(cssText, /\.calibration-dialog \.calibration-message\{[^}]*color:var\(--muted\)[^}]*font-size:var\(--font-sm\)[^}]*line-height:1\.4/u);
  assert.match(cssText, /\.calibration-report\{margin:0;padding:0;border:0;background:transparent\}/u);
  assert.match(cssText, /\.calibration-check\{padding:10px 0;border:0;border-radius:0;background:transparent\}/u);
  assert.doesNotMatch(cssText, /\.calibration-report-heading/u);
  assert.doesNotMatch(cssText, /\.calibration-overall/u);
  assert.match(cssText, /\.camera-slot-preview\{/u);
  assert.match(cssText, /\.camera-slot-card\{[^}]*min-height:170px[^}]*grid-template-rows:minmax\(120px,1fr\) auto/u);
  assert.match(cssText, /\.camera-slot-visual\{[^}]*min-height:120px/u);
  assert.match(cssText, /\.camera-slot-card\.empty \.camera-slot-visual\{[^}]*background:#0b1015/u);
  assert.match(cssText, /\.camera-slot-empty-footer\{border-top:0;background:#0b1015\}/u);
  assert.match(cssText, /\.camera-slot-add\{[^}]*width:30px;height:30px[^}]*border:0[^}]*background:transparent/u);
  assert.match(cssText, /\.camera-slot-actions button\{width:30px;height:30px;display:grid;place-items:center;padding:0/u);
  assert.match(cssText, /\.copy-button\{[^}]*width:30px;height:30px;display:grid;place-items:center;padding:0/u);
  assert.match(cssText, /\.camera-slot-card\.drag-over\{/u);
  assert.match(cssText, /\.settings-dialog\{width:min\(520px,calc\(100vw - 32px\)\);/u);
  assert.match(cssText, /\.settings-dialog \.settings-header\{border-bottom:0\}/u);
  assert.match(cssText, /\.inference-actions\{[^}]*border-top:0\}/u);
  assert.match(cssText, /\.secret-visibility-toggle\{[^}]*width:30px;height:30px/u);
  assert.match(cssText, /\.settings-field\.inference-key-field input,\.settings-field\.camera-password-field input\{padding-right:40px\}/u);
  assert.match(cssText, /\.lucide\{width:var\(--icon-md\);height:var\(--icon-md\);display:block;flex:none\}/u);
  assert.match(cssText, /\.app-icon-button \.lucide,\.dialog-close \.lucide\{width:var\(--icon-lg\);height:var\(--icon-lg\)\}/u);
  assert.match(cssText, /\.camera-slot-actions \.lucide,\.copy-button \.lucide\{width:var\(--icon-md\);height:var\(--icon-md\)\}/u);
  assert.doesNotMatch(cssText, /secret-icon/u);
  assert.match(cssText, /\.camera-editor-dialog\{position:fixed;inset:0 0 0 auto;/u);
  assert.match(cssText, /\.camera-editor-overlay\{position:absolute;inset:0;z-index:20/u);
  assert.match(cssText, /\.camera-editor-dialog\.add-mode\{position:absolute;inset:0;z-index:21;width:100%/u);
  assert.match(cssText, /\.camera-editor-dialog\.add-mode[^}]*height:100%[^}]*transform:none[^}]*border:0[^}]*border-radius:0[^}]*box-shadow:none/u);
  assert.match(cssText, /\.camera-discovery-action\{justify-self:end;display:flex;align-items:center;gap:8px\}/u);
  assert.match(cssText, /\.camera-action-spinner\{width:14px;height:14px;flex:none;border:2px solid #4f5963;border-top-color:#9aa4ad;border-radius:50%;visibility:hidden;animation:inference-spin \.8s linear infinite\}/u);
  assert.match(cssText, /\.camera-action-spinner\.active\{visibility:visible\}/u);
  assert.match(cssText, /button:disabled,input:disabled,textarea:disabled,select:disabled\{cursor:not-allowed;opacity:1\}/u);
  assert.match(cssText, /select:focus,textarea:focus,input:focus\{border-color:var\(--text\);box-shadow:0 0 0 2px rgba\(236,241,246,.08\)\}/u);
  assert.match(cssText, /\.settings-field input:focus,\.settings-field select:focus\{border-color:var\(--text\);box-shadow:0 0 0 2px rgba\(236,241,246,.08\)\}/u);
  assert.match(cssText, /select\{appearance:none;-webkit-appearance:none;background-image:url\("data:image\/svg\+xml,[^)]*"\);background-repeat:no-repeat;background-position:right 18px center;background-size:10px 6px\}/u);
  assert.doesNotMatch(cssText, /button:disabled,input:disabled,textarea:disabled,select:disabled\{[^}]*opacity:\.55/u);
  assert.match(cssText, /\.camera-editor-header\{border-bottom:0\}/u);
  assert.match(cssText, /\.credential-block\{[^}]*border-top:0\}/u);
  assert.match(cssText, /\.camera-form-actions\{[^}]*border-top:0\}/u);
  assert.match(cssText, /\.settings-field>\.camera-password-help,\.camera-connect-warning\{[^}]*font-weight:500[^}]*letter-spacing:0[^}]*text-align:right\}/u);
  assert.match(cssText, /\.settings-field>\.camera-password-help\{display:block;margin:5px 0 7px\}/u);
  assert.match(cssText, /\.camera-connect-warning\{display:flex;flex-direction:column;align-items:flex-end;margin-top:6px\}/u);

  assert.match(cssText, /\.camera-preparation/u);
  assert.match(cssText, /\.camera-discovery-results/u);
  assert.match(cssText, /\.camera-discovery-block\{display:grid;margin:13px 0 0;padding:0;border:0;background:transparent\}/u);
  assert.match(cssText, /\.calibration-report\{/u);
  assert.doesNotMatch(cssText, /\.schedule-controls\{/u);
  assert.match(cssText, /\.scheduled-tasks-dialog\{width:min\(760px,calc\(100vw - 32px\)\)/u);
  assert.match(cssText, /\.scheduled-task-list\{display:grid;gap:7px\}/u);
  assert.match(cssText, /\.scheduled-task-row\{display:grid;grid-template-columns:minmax\(0,1fr\) auto/u);
  assert.match(cssText, /\.schedule-editor-actions\{display:flex;justify-content:flex-end;gap:7px\}/u);
  assert.match(cssText, /\.control-columns\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\);gap:28px/u);
  assert.doesNotMatch(cssText, /\.video-controls\{/u);
  assert.doesNotMatch(cssText, /\.video-state-row\{/u);
  assert.doesNotMatch(cssText, /\.video-summary\{/u);
  assert.match(cssText, /select\{height:36px;/u);
  assert.match(cssText, /input\[type=text\],input\[type=password\],input\[type=number\]\{height:37px;/u);
  assert.match(cssText, /\.secondary-button,\.danger-button,\.primary-settings-button\{height:35px;/u);
  assert.match(cssText, /\.prompt-field>label,\.artifact-field>label\{display:block;margin:0 0 7px/u);
  assert.match(cssText, /\.settings-field>span,\.settings-field>label\{display:block;margin:0 0 7px/u);
  assert.match(cssText, /\.left-mode-stack \.input-mode-row\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/u);
  assert.match(cssText, /\.left-mode-stack \.input-mode-row label\{min-width:0\}/u);
  assert.match(cssText, /\.left-mode-stack \.compact-row legend,\.capability-row legend\{[^}]*padding-bottom:2px/u);

  const icons = await fetch(`${running.url}/assets/icons.js`);
  assert.equal(icons.status, 200);
  assert.match(icons.headers.get("content-type"), /text\/javascript/u);
  const iconsText = await icons.text();
  assert.match(iconsText, /export function createLucideIcon/u);
  assert.match(iconsText, /"grid-2x2"/u);
  assert.match(iconsText, /"eye-off"/u);
  assert.match(iconsText, /"square-pen"/u);
  assert.match(iconsText, /"trash-2"/u);
  assert.match(iconsText, /copy:/u);

  const script = await fetch(`${running.url}/assets/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /text\/javascript/u);
  const browserModuleSources = [await script.text()];
  for (const moduleName of ["api", "camera-discovery", "lifecycle", "schedules", "settings", "ui", "video", "viewer"]) {
    const moduleResponse = await fetch(`${running.url}/assets/${moduleName}.js`);
    assert.equal(moduleResponse.status, 200);
    assert.match(moduleResponse.headers.get("content-type"), /text\/javascript/u);
    browserModuleSources.push(await moduleResponse.text());
  }
  const scriptText = browserModuleSources.join("\n");
  assert.match(scriptText, /api\("\/api\/runs\/capture"/u);
  assert.match(scriptText, /api\("\/api\/runs\/file"/u);
  assert.match(scriptText, /URL\.createObjectURL\(file\)/u);
  assert.match(scriptText, /"x-portus-qc-inspection-id": encodeURIComponent\(inspectionId\)/u);
  assert.match(scriptText, /selectedInputMode\(\) === "file"/u);
  assert.doesNotMatch(scriptText, /x-portus-qc-capture-id/u);
  assert.match(scriptText, /\/api\/runs\/\$\{encodeURIComponent\(captured\.captureId\)\}\/process/u);
  assert.match(scriptText, /inference-spinner/u);
  assert.match(scriptText, /let controlsBound = false;/u);
  assert.match(scriptText, /if \(controlsBound\) return;\s*controlsBound = true;/u);
  assert.doesNotMatch(scriptText, /\/api\/results\/current/u);
  assert.match(scriptText, /"no-camera": "No Camera", connecting: "Connecting\.\.\.", ready: "Ready"/u);
  assert.match(scriptText, /\/api\/cameras\/_actions\/discover/u);
  assert.match(scriptText, /\/api\/cameras\/_actions\/connect/u);
  assert.match(scriptText, /\/api\/cameras\/\$\{encodeURIComponent\(camera\.id\)\}\/preview/u);
  assert.match(scriptText, /\/api\/cameras\/\$\{encodeURIComponent\(camera\.id\)\}\/slot/u);
  assert.match(scriptText, /card\.draggable = !state\.cameraManagerBusy/u);
  assert.match(scriptText, /event\.dataTransfer\.setData\("text\/plain", camera\.id\)/u);
  assert.doesNotMatch(scriptText, /api\("\/api\/cameras", \{ method: "POST"/u);
  assert.match(scriptText, /setCameraManagerOpen\(!state\.cameraManagerOpen\)/u);
  assert.match(scriptText, /elements\.resultPanelHeader\.hidden = state\.cameraManagerOpen/u);
  assert.match(scriptText, /elements\.resultPanel\.classList\.toggle\("camera-management-open", state\.cameraManagerOpen\)/u);
  assert.match(scriptText, /add\.className = "camera-slot-add"; add\.append\(createLucideIcon\("plus"\)\)/u);
  assert.match(scriptText, /edit\.className = "edit-camera"; edit\.append\(createLucideIcon\("square-pen"\)\)/u);
  assert.match(scriptText, /remove\.className = "delete-camera"; remove\.append\(createLucideIcon\("trash-2"\)\)/u);
  assert.match(scriptText, /copy\.className = "copy-button";\s*copy\.append\(createLucideIcon\("copy"\)\)/u);
  assert.doesNotMatch(scriptText, /edit\.textContent = "Edit"/u);
  assert.doesNotMatch(scriptText, /remove\.textContent = "Delete"/u);
  assert.doesNotMatch(scriptText, /copy\.textContent = "Copy"/u);
  assert.doesNotMatch(scriptText, /add\.textContent = "\+"/u);
  assert.doesNotMatch(scriptText, /camera-slot-empty-button/u);
  assert.match(scriptText, /elements\.cameraAlias\.hidden = displayingFile \|\| !alias/u);
  assert.match(scriptText, /elements\.cameraSlotSelectors\.hidden = displayingFile/u);
  assert.match(scriptText, /elements\.cameraStatus\.hidden = state\.visibleSourceKind === "file"/u);
  assert.match(scriptText, /api\("\/api\/inference\/moondream", \{/u);
  assert.match(scriptText, /\/api\/inference\/moondream\/key/u);
  assert.match(scriptText, /x-portus-qc-console-secret/u);
  assert.doesNotMatch(scriptText, /\/api\/inference\/moondream\/test/u);
  assert.doesNotMatch(scriptText, /\/api\/inference\/moondream\/model/u);
  assert.match(scriptText, /\/api\/video\/session/u);
  assert.match(scriptText, /function videoSessionActive\(\)/u);
  assert.match(scriptText, /videoActive\s*\?\s*state\.videoBusy/u);
  assert.match(scriptText, /elements\.runLabel\.textContent = state\.videoBusy/u);
  assert.match(scriptText, /inputMode === "video" \|\| inputMode === "file"/u);
  assert.match(scriptText, /onDemand\.checked = true/u);
  assert.doesNotMatch(scriptText, /\/api\/results\/current/u);
  assert.match(scriptText, /api\("\/api\/schedules"\)/u);
  assert.match(scriptText, /method: editingId \? "PUT" : "POST"/u);
  assert.match(scriptText, /method: "PATCH"/u);
  assert.match(scriptText, /schedule\.enabled \? "Disarm" : "Arm"/u);
  assert.match(scriptText, /schedules\.open\(\)/u);
  assert.doesNotMatch(scriptText, /\/api\/results\/current/u);
  assert.match(scriptText, /sessionId = globalThis\.crypto\.randomUUID\(\)/u);
  assert.match(scriptText, /heartbeatMs = 1_500/u);
  assert.match(scriptText, /\/api\/console\/session\/\$\{encodeURIComponent\(sessionId\)\}\/\$\{action\}/u);
  assert.match(scriptText, /navigatorRef\.sendBeacon\(path\)/u);
  assert.match(scriptText, /windowRef\.addEventListener\("pageshow"/u);
  assert.match(scriptText, /windowRef\.addEventListener\("pagehide"/u);
  assert.match(scriptText, /CONSOLE_INSPECTION_ID = "console-inspection"/u);
  assert.match(scriptText, /method: "DELETE"/u);
  assert.match(scriptText, /state\.inspections = state\.inspections\.filter\(\(item\) => item\.id !== inspection\.id\);/u);
  assert.match(scriptText, /state\.selectedInspectionId = "";/u);
  assert.match(scriptText, /apiKeyInput\.value = apiKey;/u);
  assert.match(scriptText, /apiKeyInput\.placeholder = "Your API Key";/u);
  assert.match(scriptText, /setSecretVisibility\(apiKeyInput, apiKeyToggle, visible/u);
  assert.match(scriptText, /showLabel: "Show API Key"/u);
  assert.match(scriptText, /hideLabel: "Hide API Key"/u);
  assert.match(scriptText, /apiKeyToggle\.addEventListener\("click"/u);
  assert.doesNotMatch(scriptText, /removeMoondreamKey/u);
  assert.doesNotMatch(scriptText, /testMoondream/u);
  assert.doesNotMatch(scriptText, /The active key comes from the repository \.env fallback/u);
  assert.match(scriptText, /This report evaluates the image currently shown in Input\./u);
  assert.doesNotMatch(scriptText, /Informational only\. This report evaluates the exact image currently shown in Input and never blocks inspections\./u);
  assert.doesNotMatch(scriptText, /calibration-report-heading/u);

  assert.match(scriptText, /Use RTSP\/Camera Account Username and Password\./u);
  assert.doesNotMatch(scriptText, /cameraCredentialState/u);
  assert.doesNotMatch(scriptText, /cameraEditorTitle/u);
  assert.match(scriptText, /elements\.cameraUsername\.value = "";/u);
  assert.match(scriptText, /elements\.cameraPassword\.value = "";/u);
  assert.match(scriptText, /setSecretVisibility\(elements\.cameraPassword, elements\.cameraPasswordToggle, visible/u);
  assert.match(scriptText, /showLabel: "Show Password"/u);
  assert.match(scriptText, /hideLabel: "Hide Password"/u);
  assert.match(scriptText, /elements\.cameraPasswordToggle\.addEventListener\("click"/u);
  assert.match(scriptText, /createCameraDiscoveryController\(/u);
  assert.match(scriptText, /let busy = false;/u);
  assert.match(scriptText, /button\.disabled = busy;/u);
  assert.match(scriptText, /button\.setAttribute\("aria-busy", String\(busy\)\);/u);
  assert.match(scriptText, /spinner\.classList\.toggle\("active", busy\);/u);
  assert.doesNotMatch(scriptText, /cameraDiscoverButton\.textContent = busy/u);
  assert.match(scriptText, /state\.cameraEditorBusy \|\| cameraDiscovery\.isBusy\(\)/u);
  assert.match(scriptText, /elements\.cameraConnectButton\.setAttribute\("aria-busy", String\(busy\)\);/u);
  assert.match(scriptText, /elements\.cameraConnectSpinner\.classList\.toggle\("active", busy\);/u);
  assert.doesNotMatch(scriptText, /elements\.cameraConnectLabel\.textContent = "Connecting…";/u);
  assert.match(scriptText, /elements\.runButton\.setAttribute\("aria-busy", "true"\);/u);
  assert.match(scriptText, /elements\.runButton\.setAttribute\("aria-busy", "false"\);/u);
  assert.doesNotMatch(scriptText, /elements\.runButton\.classList\.add\("running"\)/u);
  assert.doesNotMatch(scriptText, /elements\.runLabel\.textContent = "Capturing…"/u);
  assert.doesNotMatch(scriptText, /elements\.runLabel\.textContent = "Processing…"/u);
  assert.match(scriptText, /Discovering available cameras…/u);
  assert.match(scriptText, /No available cameras were found\. You can enter Host \/ IP manually\./u);
  assert.match(scriptText, /Camera discovery is unavailable\. You can enter Host \/ IP manually\./u);
  assert.doesNotMatch(scriptText, /setEditorMessage\(error\.message/u);
  assert.match(scriptText, /logWarning\(error\?\.message \|\| "Camera discovery failed\."\);/u);
  assert.doesNotMatch(scriptText, /Camera discovery failed\. You can still enter the host\/IP manually as the Camsnap fallback\./u);
  assert.doesNotMatch(scriptText, /Use this discovered camera/u);
  assert.match(scriptText, /row\.append\(host, choose\);/u);
  assert.match(scriptText, /hostInput\.value = candidate\.host;/u);
  assert.match(scriptText, /portInput\.value = "";/u);
  assert.doesNotMatch(scriptText, /portInput\.value = candidate\.port/u);
  assert.match(scriptText, /setEditorMessage\("Enter the camera Username and Password\."\);/u);
  assert.doesNotMatch(scriptText, /Discovered camera selected\. Enter its camera-local username and password, then Connect\./u);
  assert.match(scriptText, /cameraDiscovery\.clearResults\(\);/u);
  assert.doesNotMatch(scriptText, /Select Discover Cameras, or enter the host\/IP manually if discovery does not find it\./u);
  assert.match(scriptText, /elements\.cameraManager\.append\(elements\.cameraEditorDialog\)/u);
  assert.match(scriptText, /elements\.cameraEditorKicker\.textContent = `\$\{camera \? "EDIT CAMERA" : "ADD CAMERA"\} \$\{slot\}`/u);
  assert.match(scriptText, /elements\.cameraEditorDialog\.show\(\)/u);
  assert.doesNotMatch(scriptText, /elements\.cameraEditorDialog\.showModal\(\)/u);
  assert.doesNotMatch(scriptText, /camera\.username/u);
  assert.doesNotMatch(scriptText, /camera\.password/u);

  const missing = await fetch(`${running.url}/not-a-route`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");

  const wrongMethod = await fetch(`${running.url}/health`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
});

test("service rejects non-loopback binding even when config is overridden", async () => {
  assert.doesNotThrow(() => assertLoopbackHost("127.0.0.1"));
  assert.doesNotThrow(() => assertLoopbackHost("localhost"));
  assert.doesNotThrow(() => assertLoopbackHost("::1"));
  assert.throws(() => assertLoopbackHost("0.0.0.0"), /loopback/u);
  assert.throws(() => assertLoopbackHost("192.168.1.50"), /loopback/u);

  const config = await loadAppConfig({ session: { runtime: { host: "0.0.0.0" } } });
  await assert.rejects(() => startPortusQcService({ config }), /loopback/u);
});

test("started service uses loaded config and stops idempotently", async () => {
  const probe = await startEphemeralServer();
  const port = new URL(probe.url).port;
  await new Promise((resolve, reject) => probe.server.close((error) => error ? reject(error) : resolve()));

  const config = await loadAppConfig({ session: { runtime: { host: "127.0.0.1", port: Number(port) } } });
  const service = await startPortusQcService({ config, startedAt: "2026-08-27T00:00:00.000Z" });
  assert.equal(service.host, "127.0.0.1");
  assert.equal(service.port, Number(port));
  assert.equal((await fetch(`${service.url}/health`)).status, 200);
  const firstStop = service.stop();
  const secondStop = service.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  await assert.rejects(() => fetch(`${service.url}/health`));
});
