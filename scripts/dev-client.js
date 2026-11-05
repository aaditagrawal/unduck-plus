const devVersion = document.currentScript.dataset.version;
const updates = new EventSource("/__dev_events");
updates.onmessage = ({ data }) => {
  const update = JSON.parse(data);
  if (update.version !== undefined && update.version !== devVersion) {
    location.reload();
    return;
  }
  if (update.css !== undefined) {
    const link = document.querySelector('link[rel="stylesheet"][href*="/__dev_style.css"]');
    if (!link) return;
    const apply = () => {
      let style = document.getElementById("__dev_style");
      if (!style) {
        style = document.createElement("style");
        style.id = "__dev_style";
        document.head.append(style);
      }
      style.textContent = update.css;
      link.disabled = true;
    };
    if (link.disabled || link.sheet) apply();
    else link.addEventListener("load", apply, { once: true });
  }
};
