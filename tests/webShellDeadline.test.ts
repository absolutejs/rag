import { expect, test } from "bun:test";
import { hasEmptyAppRoot } from "../src/web/evidence";

test("repeated attributes finish inside an externally enforced deadline", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      new URL("./fixtures/repeatedAttributes.ts", import.meta.url).pathname,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    expect(await child.exited).toBe(0);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}, 5000);

test("empty app detection parses attributes, whitespace, and children", () => {
  expect(hasEmptyAppRoot('<main ID="root">  </main>')).toBe(true);
  expect(hasEmptyAppRoot('<section class="widget todoapp"></section>')).toBe(
    true,
  );
  expect(hasEmptyAppRoot('<div id="app"><span></span></div>')).toBe(false);
  expect(hasEmptyAppRoot('<div id="__next">Evidence</div>')).toBe(false);
  expect(hasEmptyAppRoot('<div title="id=app"></div>')).toBe(false);
});
