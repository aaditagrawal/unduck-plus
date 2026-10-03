import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { bangs } from "../src/bang";

const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const script = new Bun.Transpiler().transformSync(source.replace(/^import .*\n/gm, ""), "ts");

function run(query, storage = { getItem: () => null }) {
  let destination;
  const button = { addEventListener() {}, querySelector: () => ({}) };
  const app = {
    innerHTML: "",
    querySelector: (selector) => (selector === ".copy-button" ? button : {}),
  };
  runInNewContext(script, {
    bangs,
    URL,
    localStorage: storage,
    document: { querySelector: () => app },
    window: {
      location: {
        href: "https://self.test/search?q=" + encodeURIComponent(query),
        origin: "https://self.test",
        pathname: "/search",
        replace: (url) => {
          destination = url;
        },
      },
    },
  });
  return { destination, html: app.innerHTML };
}

test("relative templates use their provider domain", () => {
  const target = new URL(run("!typescript arrays").destination);
  expect(target.host).toBe("kagi.com");
  expect(target.searchParams.get("q")).toBe("arrays site:www.typescriptlang.org");
});

test("all placeholders are substituted", () => {
  for (const trigger of ["pagesjaunes", "mpgpure", "yesasia"]) {
    expect(run("!" + trigger + " pizza").destination).not.toContain("{{{s}}}");
  }
});

test("denied storage and invalid saved preferences retain the default search", () => {
  const denied = {
    getItem() {
      throw new Error("denied");
    },
  };
  expect(new URL(run("hello", denied).destination).host).toBe("google.com");
  expect(new URL(run("hello", { getItem: () => "missing-trigger" }).destination).host).toBe(
    "google.com",
  );
  expect(new URL(run("!gh", denied).destination).host).toBe("github.com");
});

test("homepage search template follows its own deployment", () => {
  expect(run("").html).toContain('value="https://self.test/search?q=%s"');
});
