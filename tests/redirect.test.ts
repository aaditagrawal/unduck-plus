import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
// Execute the real redirect entrypoint with browser globals and the generated
// JSON map, without importing homepage UI or following any network redirects.
const script = new Bun.Transpiler({ loader: "ts" }).transformSync(
  source.replace('import rawBangs from "./bangs.json";', "const rawBangs = JSON.parse(bangJson);"),
);
const bangJson = readFileSync(new URL("../src/bangs.json", import.meta.url), "utf8");

function redirect(query: string, defaultBang: string | null = null) {
  const replace = (target: string) => redirects.push(target);
  const redirects: string[] = [];
  runInNewContext(script, {
    bangJson,
    URL,
    URLSearchParams,
    location: { search: `?q=${encodeURIComponent(query)}`, replace },
    localStorage: { getItem: () => defaultBang },
  });
  expect(redirects).toHaveLength(1);
  return redirects[0];
}

describe("bang redirects", () => {
  test("normal queries use Google and encode query characters", () => {
    expect(redirect("cats & dogs")).toBe("https://google.com/search?q=cats%20%26%20dogs");
  });

  test("explicit bangs override the saved default and preserve slash queries", () => {
    expect(redirect("!GH codemirror/state", "g")).toBe(
      "https://github.com/search?utf8=✓&q=codemirror/state",
    );
  });

  test("bare bangs navigate to the landing origin", () => {
    expect(redirect("!gh")).toBe("https://github.com");
  });

  test("tuple bangs retain their search template and separate HTTPS landing domain", () => {
    expect(redirect("!5 cats")).toBe("http://fiverr.com/gigs/search?query=cats");
    expect(redirect("!5")).toBe("https://fiverr.com");
  });

  test("a saved real default handles ordinary queries and unknown bangs", () => {
    expect(redirect("cats", "gh")).toBe("https://github.com/search?utf8=✓&q=cats");
    expect(redirect("!not-a-trigger cats", "gh")).toBe("https://github.com/search?utf8=✓&q=cats");
  });

  for (const name of ["__proto__", "constructor", "toString"]) {
    test(`prototype trigger ${name} falls back to a real saved default`, () => {
      expect(redirect(`!${name} cats`, "gh")).toBe("https://github.com/search?utf8=✓&q=cats");
    });

    test(`prototype default ${name} falls back to Google`, () => {
      expect(redirect("cats", name)).toBe("https://google.com/search?q=cats");
      expect(redirect("!not-a-trigger cats", name)).toBe("https://google.com/search?q=cats");
      expect(redirect("!gh cats", name)).toBe("https://github.com/search?utf8=✓&q=cats");
    });
  }
});
