import { describe, expect, test } from "bun:test";
import { rankRAGLexicalMatches } from "../src/retrieval/lexical";

describe("multilingual original evidence retrieval", () => {
  for (const [query, text] of [
    ["预算", "项目预算为人民币 17431.29 元。"],
    ["予算", "今回の予算は17431円です。"],
    ["бюджет", "Исправленный бюджет составляет 17431 рубль."],
    ["الميزانية", "الميزانية المعتمدة 17431 دولار"],
    ["café", "Le café coûte 17431 euros."],
    ["cafe\u0301", "Le café coûte 17431 euros."],
    ["17431.29", "Corrected spending ceiling: $17431.29."],
    ["7", "There are 7 members."],
  ]) {
    test(`retrieves original passage for ${query}`, () => {
      const results = rankRAGLexicalMatches(query!, [
        {
          chunkId: "noise",
          text: "Unrelated boilerplate for an ordinary project.",
        },
        { chunkId: "fact", text: text! },
      ]);
      expect(results[0]?.result.chunkId).toBe("fact");
      expect(results[0]?.result.text).toBe(text);
    });
  }
  test("does not confuse accented words with their unaccented prefix", () => {
    const results = rankRAGLexicalMatches("résumé", [
      { chunkId: "noise", text: "The rest is unrelated." },
      { chunkId: "fact", text: "Voici mon résumé professionnel." },
    ]);
    expect(results.map((item) => item.result.chunkId)).toEqual(["fact"]);
  });
});
