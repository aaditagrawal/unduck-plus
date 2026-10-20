import "./global.css";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh;">
    <div class="content-container">
      <h1>SearchLock</h1>
      <p>DuckDuckGo's bang redirects are too slow. Add the following URL as a custom search engine to your browser. Enables <a href="https://duckduckgo.com/bang.html" target="_blank">all of DuckDuckGo's bangs.</a></p>
      <div class="url-container">
        <input
          type="text"
          class="url-input"
          value="https://sea.sys256.com?q=%s"
          readonly
        />
        <button class="copy-button">
          <img src="/clipboard.svg" alt="Copy" />
        </button>
      </div>
    </div>
    <footer class="footer">
      <a href="https://aadit.cc" target="_blank">me</a>
      •
      <a href="https://x.com/theo" target="_blank">theo</a>
      •
      <a href="https://github.com/t3dotgg/unduck" target="_blank">github</a>
      •
      <a href="https://github.com/aaditagrawal/unduck-plus" target="_blank">github_of_fork</a>
    </footer>
  </div>
`;

const copyButton = app.querySelector<HTMLButtonElement>(".copy-button")!;
const copyIcon = copyButton.querySelector("img")!;
const urlInput = app.querySelector<HTMLInputElement>(".url-input")!;

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(urlInput.value);
  copyIcon.src = "/clipboard-check.svg";

  setTimeout(() => {
    copyIcon.src = "/clipboard.svg";
  }, 2000);
});
