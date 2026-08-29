const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = Object.freeze({
  "grid-2x2": [
    ["rect", { x: "3", y: "3", width: "7", height: "7", rx: "1" }],
    ["rect", { x: "14", y: "3", width: "7", height: "7", rx: "1" }],
    ["rect", { x: "3", y: "14", width: "7", height: "7", rx: "1" }],
    ["rect", { x: "14", y: "14", width: "7", height: "7", rx: "1" }]
  ],
  settings: [
    ["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }],
    ["circle", { cx: "12", cy: "12", r: "3" }]
  ],
  minus: [["path", { d: "M5 12h14" }]],
  plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
  "maximize-2": [
    ["path", { d: "M15 3h6v6" }],
    ["path", { d: "M9 21H3v-6" }],
    ["path", { d: "m21 3-7 7" }],
    ["path", { d: "m3 21 7-7" }]
  ],
  "folder-open": [
    ["path", { d: "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-2.44 7A2 2 0 0 1 17.56 21H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" }]
  ],
  "square-pen": [
    ["path", { d: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }],
    ["path", { d: "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" }]
  ],
  "trash-2": [
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
    ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
    ["line", { x1: "10", x2: "10", y1: "11", y2: "17" }],
    ["line", { x1: "14", x2: "14", y1: "11", y2: "17" }]
  ],
  copy: [
    ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]
  ],
  check: [["path", { d: "m20 6-11 11-5-5" }]],
  x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  eye: [
    ["path", { d: "M2.062 12.348a1 1 0 0 1 0-.696C3.457 7.62 7.255 5 12 5c4.745 0 8.543 2.62 9.938 6.652a1 1 0 0 1 0 .696C20.543 16.38 16.745 19 12 19s-8.543-2.62-9.938-6.652" }],
    ["circle", { cx: "12", cy: "12", r: "3" }]
  ],
  "eye-off": [
    ["path", { d: "M10.733 5.076A10.744 10.744 0 0 1 12 5c4.745 0 8.543 2.62 9.938 6.652a1 1 0 0 1 0 .696 10.8 10.8 0 0 1-1.444 2.49" }],
    ["path", { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242" }],
    ["path", { d: "M17.479 17.499A10.75 10.75 0 0 1 12 19c-4.745 0-8.543-2.62-9.938-6.652a1 1 0 0 1 0-.696 10.72 10.72 0 0 1 4.61-5.034" }],
    ["path", { d: "m2 2 20 20" }]
  ]
});

export function createLucideIcon(name, className = "") {
  const definition = ICONS[name];
  if (!definition) throw new Error(`Unknown Lucide icon: ${name}`);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("lucide", `lucide-${name}`);
  if (className) svg.classList.add(...className.split(/\s+/u).filter(Boolean));
  for (const [tag, attrs] of definition) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  return svg;
}

export function setLucideIcon(container, name, className = "") {
  container.replaceChildren(createLucideIcon(name, className));
}

export function hydrateLucideIcons(root = document) {
  for (const placeholder of root.querySelectorAll("[data-lucide]")) {
    const name = placeholder.dataset.lucide;
    if (!name) continue;
    placeholder.replaceWith(createLucideIcon(name, placeholder.className));
  }
}
