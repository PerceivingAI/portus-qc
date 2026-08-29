export function createStatusReporter(element) {
  let timer;
  return function setStatus(message, tone = "") {
    if (tone === "error") console.error(message);
    else if (tone === "warning") console.warn(message);
    if (tone !== "error" && tone !== "warning") return;
    if (timer) clearTimeout(timer);
    element.textContent = message;
    element.dataset.tone = tone;
    element.hidden = false;
    timer = setTimeout(() => {
      element.hidden = true;
      element.textContent = "";
      timer = undefined;
    }, tone === "error" ? 6_000 : 4_500);
  };
}

export function setMessage(element, message = "", tone = "") {
  element.textContent = message;
  element.dataset.tone = tone;
}

export function setSecretVisibility(input, button, visible, { showLabel, hideLabel, setIcon }) {
  input.type = visible ? "text" : "password";
  button.setAttribute("aria-pressed", String(visible));
  const label = visible ? hideLabel : showLabel;
  button.setAttribute("aria-label", label);
  button.title = label;
  setIcon(button, visible ? "eye-off" : "eye");
}
