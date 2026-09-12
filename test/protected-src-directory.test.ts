// Regression test for the src/index.ts module split: NanCy's logic used to
// live entirely in src/index.ts, so blocking writes to that one file was
// enough to stop the agent from defanging NanCy's own checks. Now that the
// logic is split across many modules under src/ (see CLAUDE.md/TODO.md), the
// write-protection must cover the whole src/ directory, not just index.ts,
// or the agent could rewrite e.g. src/policy/tool-policy.ts instead and
// leave index.ts untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi } from "./helpers.ts";

test("writes under nancy/src/ are blocked everywhere, not just index.ts", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi({});
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);

    const indexResult = await handlers.before_tool_call(
      { toolName: "write", params: { path: join(rootDir, "src", "index.ts"), content: "x" } },
      { sessionKey: "s1" },
    );
    assert.equal(indexResult?.block, true, "writing to src/index.ts itself must still be blocked");

    const moduleResult = await handlers.before_tool_call(
      { toolName: "write", params: { path: join(rootDir, "src", "policy", "tool-policy.ts"), content: "x" } },
      { sessionKey: "s1" },
    );
    assert.equal(moduleResult?.block, true, "writing to a module under src/ must be blocked, not just index.ts");
    assert.match(moduleResult.blockReason, /nancy\/src\//);
  } finally { cleanup(); }
});
