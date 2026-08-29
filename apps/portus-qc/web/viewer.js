import { createLucideIcon, setLucideIcon } from "./icons.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export function createViewer({ sourceViewport, resultViewport, resultCapability, setStatus }) {
  const transforms = { source: { scale: 1, x: 0, y: 0 }, result: { scale: 1, x: 0, y: 0 } };
  let controlsBound = false;

  function viewportFor(view) { return view === "source" ? sourceViewport : resultViewport; }

  function sourceUrl(result) {
    if (!result?.source?.available || !result.source.url) return undefined;
    return `${result.source.url}${result.source.url.includes("?") ? "&" : "?"}v=${encodeURIComponent(result.createdAt)}`;
  }

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function spatialOverlay(result) {
    const overlay = document.createElement("div");
    overlay.className = "spatial-overlay";
    const svg = svgElement("svg", { viewBox: "0 0 1 1", preserveAspectRatio: "none", "aria-hidden": "true" });
    overlay.append(svg);
    if (result.capability === "detect") {
      const label = result.prompt?.trim() || "object";
      for (const box of result.result.boxes) {
        svg.append(svgElement("rect", { x: box.xMin, y: box.yMin, width: box.xMax - box.xMin, height: box.yMax - box.yMin, fill: "none", stroke: "#000000", "stroke-opacity": ".78", "stroke-width": ".008" }));
        svg.append(svgElement("rect", { x: box.xMin, y: box.yMin, width: box.xMax - box.xMin, height: box.yMax - box.yMin, fill: "none", stroke: "#58d9e8", "stroke-width": ".004" }));
        const tag = document.createElement("span");
        tag.className = "detection-label";
        tag.textContent = label;
        tag.style.left = `${box.xMin * 100}%`;
        tag.style.top = `${box.yMin * 100}%`;
        overlay.append(tag);
      }
    } else if (result.capability === "point") {
      for (const point of result.result.points) {
        const group = svgElement("g");
        group.append(svgElement("circle", { cx: point.x, cy: point.y, r: .014, fill: "none", stroke: "#ff453a", "stroke-width": "1.0", "vector-effect": "non-scaling-stroke" }));
        group.append(svgElement("line", { x1: point.x - .02, y1: point.y, x2: point.x + .02, y2: point.y, stroke: "#ff453a", "stroke-width": "1.0", "vector-effect": "non-scaling-stroke" }));
        group.append(svgElement("line", { x1: point.x, y1: point.y - .02, x2: point.x, y2: point.y + .02, stroke: "#ff453a", "stroke-width": "1.0", "vector-effect": "non-scaling-stroke" }));
        svg.append(group);
      }
    } else if (result.capability === "segment") {
      for (const region of result.result.regions) {
        if (!region.bbox) continue;
        const transform = `translate(${region.bbox.xMin} ${region.bbox.yMin}) scale(${region.bbox.xMax - region.bbox.xMin} ${region.bbox.yMax - region.bbox.yMin})`;
        svg.append(svgElement("path", {
          d: region.path,
          transform,
          fill: "none",
          stroke: "#000000",
          "stroke-opacity": ".78",
          "stroke-width": ".010",
          "vector-effect": "non-scaling-stroke"
        }));
        svg.append(svgElement("path", {
          d: region.path,
          transform,
          fill: "#58d9e8",
          "fill-opacity": ".38",
          stroke: "#7ce8f2",
          "stroke-width": ".005",
          "vector-effect": "non-scaling-stroke"
        }));
      }
    }
    return overlay;
  }


  function transformLayer(view) {
    const viewport = viewportFor(view);
    const layer = viewport.querySelector(".media-layer");
    if (!layer) return;
    const transform = transforms[view];
    layer.style.transform = `translate(calc(-50% + ${transform.x}px), calc(-50% + ${transform.y}px)) scale(${transform.scale})`;
    const value = document.querySelector(`[data-tools="${view}"] .zoom-value`);
    if (value) value.textContent = `${Math.round(transform.scale * 100)}%`;
  }

  function resetTransform(view) {
    transforms[view] = { scale: 1, x: 0, y: 0 };
    transformLayer(view);
  }

  function fitLayer(viewport, layer, image) {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const ratio = Math.min(viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight);
    layer.style.width = `${Math.max(1, image.naturalWidth * ratio)}px`;
    layer.style.height = `${Math.max(1, image.naturalHeight * ratio)}px`;
  }

  function disposeMedia(viewport) {
    const old = viewport.querySelector(".media-layer");
    old?._resizeObserver?.disconnect();
  }

  function createMedia(view, url, overlay) {
    const viewport = viewportFor(view);
    disposeMedia(viewport);
    viewport.replaceChildren();
    viewport.classList.add("has-media");
    const layer = document.createElement("div");
    layer.className = "media-layer";
    const image = document.createElement("img");
    image.alt = view === "source" ? "Input image" : "Inspection result image";
    image.draggable = false;
    image.addEventListener("load", () => { fitLayer(viewport, layer, image); resetTransform(view); });
    image.src = url;
    layer.append(image);
    if (overlay) layer.append(overlay);
    viewport.append(layer);
    const observer = new ResizeObserver(() => fitLayer(viewport, layer, image));
    observer.observe(viewport);
    layer._resizeObserver = observer;
    return viewport;
  }

  function renderSourceEmpty(title, detail) {
    disposeMedia(sourceViewport);
    sourceViewport.classList.remove("has-media");
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const message = document.createElement("span");
    message.textContent = detail;
    empty.append(heading, message);
    sourceViewport.replaceChildren(empty);
    resetTransform("source");
  }

  function showInferenceSpinner() {
    resultViewport.querySelector(".inference-spinner")?.remove();
    const emptyState = resultViewport.querySelector(".empty-state");
    if (emptyState) emptyState.hidden = true;
    const spinner = document.createElement("div");
    spinner.className = "inference-spinner";
    spinner.setAttribute("aria-label", "Processing with Moondream");
    const ring = document.createElement("span");
    ring.className = "inference-spinner-ring";
    ring.setAttribute("aria-hidden", "true");
    spinner.append(ring);
    resultViewport.append(spinner);
  }

  function hideInferenceSpinner() {
    resultViewport.querySelector(".inference-spinner")?.remove();
    const emptyState = resultViewport.querySelector(".empty-state");
    if (emptyState) emptyState.hidden = false;
  }

  function queryOverlay(text) {
    const overlay = document.createElement("div");
    overlay.className = "query-overlay";
    overlay.textContent = text;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-button";
    copy.append(createLucideIcon("copy"));
    copy.setAttribute("aria-label", "Copy result");
    copy.title = "Copy result";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        setLucideIcon(copy, "check");
        copy.setAttribute("aria-label", "Copied");
        copy.title = "Copied";
      } catch {
        copy.setAttribute("aria-label", "Copy failed");
        copy.title = "Copy failed";
      }
      setTimeout(() => {
        setLucideIcon(copy, "copy");
        copy.setAttribute("aria-label", "Copy result");
        copy.title = "Copy result";
      }, 1_200);
    });
    overlay.append(copy);
    return overlay;
  }

  function renderResult(result) {
    resultCapability.hidden = !result;
    if (result?.capability === "detect") {
      const count = result.result.boxes.length;
      const label = result.prompt?.trim() || "object";
      resultCapability.textContent = `${count} detected · ${label}`;
    } else resultCapability.textContent = result?.capability || "";
    if (!result) {
      disposeMedia(resultViewport);
      resultViewport.classList.remove("has-media");
      resultViewport.innerHTML = '<div class="empty-state"><strong>No inspection result</strong><span>The inspection result will appear here.</span></div>';
      return;
    }
    const url = sourceUrl(result);
    disposeMedia(resultViewport);
    resultViewport.classList.remove("has-media");
    if (result.capability === "caption") {
      const viewport = url ? createMedia("result", url) : resultViewport;
      const wrapper = document.createElement("div");
      wrapper.className = "text-result";
      const card = document.createElement("div");
      card.className = "text-result-card";
      const label = document.createElement("p");
      label.className = "text-label";
      label.textContent = "Caption";
      const text = document.createElement("p");
      text.textContent = result.result.text;
      card.append(label, text);
      wrapper.append(card);
      if (!url) viewport.replaceChildren(wrapper);
      else viewport.append(wrapper);
      return;
    }
    if (!url) {
      resultViewport.innerHTML = '<div class="empty-state"><strong>Result image unavailable</strong><span>The structured result is still preserved.</span></div>';
      return;
    }
    const viewport = createMedia("result", url, result.capability === "query" ? undefined : spatialOverlay(result));
    if (result.capability === "query") viewport.append(queryOverlay(result.result.text));
  }

  function setupViewer(view) {
    const viewport = viewportFor(view);
    let dragging = false;
    let pointerId;
    let lastX = 0;
    let lastY = 0;
    viewport.addEventListener("wheel", (event) => {
      if (!viewport.querySelector(".media-layer")) return;
      event.preventDefault();
      const transform = transforms[view];
      transform.scale = Math.min(8, Math.max(.5, transform.scale * (event.deltaY < 0 ? 1.12 : .89)));
      transformLayer(view);
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      if (!viewport.querySelector(".media-layer") || event.button !== 0) return;
      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.setPointerCapture(pointerId);
      viewport.classList.add("dragging");
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      const transform = transforms[view];
      transform.x += event.clientX - lastX;
      transform.y += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      transformLayer(view);
    });
    const stop = (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      viewport.classList.remove("dragging");
      if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
    };
    viewport.addEventListener("pointerup", stop);
    viewport.addEventListener("pointercancel", stop);
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;
    for (const button of document.querySelectorAll("[data-view][data-action]")) button.addEventListener("click", async () => {
      const view = button.dataset.view;
      const action = button.dataset.action;
      if (action === "reset") resetTransform(view);
      else if (action === "zoom-in" || action === "zoom-out") {
        const transform = transforms[view];
        transform.scale = Math.min(8, Math.max(.5, transform.scale * (action === "zoom-in" ? 1.2 : .833333)));
        transformLayer(view);
      } else if (action === "fullscreen") {
        const viewport = viewportFor(view);
        try { await viewport.requestFullscreen(); }
        catch { setStatus("Full-screen viewing is unavailable in this browser.", "warning"); }
      }
    });
    setupViewer("source");
    setupViewer("result");
  }

  return {
    bindControls,
    createMedia,
    hideInferenceSpinner,
    renderResult,
    renderSourceEmpty,
    showInferenceSpinner
  };
}
