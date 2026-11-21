import { expect, test } from "bun:test";
import {
  normalizeReviewEcho,
  checkResearchValue,
} from "../src/research/schema";
import { reviewSchemaForPaths } from "../src/research/evidence";
const verdict = {
  path: "/name",
  value: "Example",
  verdict: "supported",
  reason: "Source",
  citations: [],
  checks: {
    answersQuestion: true,
    correctEntity: true,
    correctTime: true,
    preservesScope: true,
  },
};
const payload = { fields: [{ path: "/name", value: "Example" }] };
test("matching scalar echo is accepted without modifying source or draft", () => {
  const raw = { fields: [verdict] };
  const normalized = normalizeReviewEcho(raw, payload);
  expect(checkResearchValue(reviewSchemaForPaths(["/name"]), normalized)).toBe(
    true,
  );
  expect(verdict.value).toBe("Example");
  expect(payload.fields[0]?.value).toBe("Example");
});
test("contradictory echoes, other extra properties and foreign paths remain invalid", () => {
  for (const field of [
    { ...verdict, value: "Invented" },
    { ...verdict, extra: true },
    { ...verdict, path: "/other" },
  ])
    expect(
      checkResearchValue(
        reviewSchemaForPaths(["/name"]),
        normalizeReviewEcho({ fields: [field] }, payload),
      ),
    ).toBe(false);
});
