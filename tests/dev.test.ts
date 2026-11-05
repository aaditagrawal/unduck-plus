import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("development handles atomic saves and recovers when a missing import is created", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "searchlock-dev-"));
  const root = resolve(import.meta.dir, "..");
  let child;
  try {
    for (const name of ["scripts", "src", "public", "index.html"])
      await cp(resolve(root, name), resolve(directory, name), { recursive: true });
    child = Bun.spawn([process.execPath, "scripts/dev.mjs"], {
      cwd: directory,
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    let errors = "";
    const stderr = (async () => {
      for await (const chunk of child.stderr) errors += new TextDecoder().decode(chunk);
    })();
    const reader = child.stdout.getReader();
    let output = "";
    while (!/Development server on port \d+/.test(output)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Development server exited: ${output}`);
      output += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const url = `http://127.0.0.1:${/Development server on port (\d+)/.exec(output)![1]}`;
    const original = await readFile(resolve(directory, "index.html"), "utf8");
    for (const title of ["First atomic save", "Second atomic save"]) {
      await writeFile(resolve(directory, "next.html"), original.replace("SearchLock", title));
      await rename(resolve(directory, "next.html"), resolve(directory, "index.html"));
      let updated = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await (await fetch(url)).text()).includes(title)) {
          updated = true;
          break;
        }
        await Bun.sleep(50);
      }
      expect(updated).toBe(true);
    }
    const mainPath = resolve(directory, "src/main.ts");
    await writeFile(mainPath, 'import "./new.ts";\n' + (await readFile(mainPath, "utf8")));
    for (
      let attempt = 0;
      attempt < 100 && !errors.includes('Could not resolve: "./new.ts"');
      attempt++
    )
      await Bun.sleep(50);
    expect(errors).toContain('Could not resolve: "./new.ts"');
    await writeFile(resolve(directory, "src/new.ts"), "globalThis.__developmentRecovery = true;");
    let recovered = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const html = await (await fetch(url)).text();
      const entry = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
      if (entry && (await (await fetch(url + entry)).text()).includes("__developmentRecovery")) {
        recovered = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(recovered).toBe(true);
    child.kill();
    await child.exited;
    await stderr;
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
