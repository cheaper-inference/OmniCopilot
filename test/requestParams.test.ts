import { describe, expect, it } from "vitest";
import { requestParamsFromModelOptions } from "../src/requestParams";

const from = (modelOptions: unknown, maxOutputTokens = 4096) =>
  requestParamsFromModelOptions(modelOptions as Record<string, unknown> | undefined, {
    maxOutputTokens,
  });

describe("requestParamsFromModelOptions", () => {
  it("returns nothing for no options, an empty object or a value that is not an object", () => {
    expect(from(undefined)).toEqual({});
    expect(from({})).toEqual({});
    expect(from("max_tokens")).toEqual({});
    expect(from(null)).toEqual({});
    expect(from([1, 2])).toEqual({});
  });

  it("forwards nothing but the listed parameters", () => {
    expect(
      from({ reasoning_effort: "high", tool_choice: "none", foo: 1, model: "x" })
    ).toEqual({});
  });

  describe("max_tokens", () => {
    it("accepts a positive integer", () => {
      expect(from({ max_tokens: 200 })).toEqual({ max_tokens: 200 });
    });

    it.each(["max_completion_tokens", "maxTokens"])("accepts the alias %s", (alias) => {
      expect(from({ [alias]: 300 })).toEqual({ max_tokens: 300 });
    });

    it("prefers max_tokens over its aliases", () => {
      expect(from({ maxTokens: 30, max_completion_tokens: 20, max_tokens: 10 })).toEqual({
        max_tokens: 10,
      });
    });

    it("falls through to an alias when the first spelling holds a bad value", () => {
      expect(from({ max_tokens: "10", maxTokens: 30 })).toEqual({ max_tokens: 30 });
    });

    it("never goes above the output limit the model was listed with", () => {
      expect(from({ max_tokens: 100_000 }, 4096)).toEqual({ max_tokens: 4096 });
      expect(from({ max_tokens: 4096 }, 4096)).toEqual({ max_tokens: 4096 });
    });

    it.each([0, -5, 1.5, NaN, Infinity, "200", null, true, {}])("drops %j", (value) => {
      expect(from({ max_tokens: value })).toEqual({});
    });
  });

  describe("temperature", () => {
    it.each([0, 0.7, 2])("accepts %s", (value) => {
      expect(from({ temperature: value })).toEqual({ temperature: value });
    });

    it.each([Number.NaN, "0.5", -0.1, 2.1, Number.POSITIVE_INFINITY])("drops %s", (value) => {
      expect(from({ temperature: value })).toEqual({});
    });
  });

  describe("top_p", () => {
    it.each([0.5, 1, 0.01])("accepts %s", (value) => {
      expect(from({ top_p: value })).toEqual({ top_p: value });
    });

    it("accepts the alias topP", () => {
      expect(from({ topP: 0.9 })).toEqual({ top_p: 0.9 });
    });

    it.each([0, -0.1, 1.01, NaN, Infinity, "0.5", null])("drops %j", (value) => {
      expect(from({ top_p: value })).toEqual({});
    });
  });

  describe("stop", () => {
    it("accepts a non-empty string", () => {
      expect(from({ stop: "\n" })).toEqual({ stop: "\n" });
    });

    it("accepts one to four non-empty strings", () => {
      expect(from({ stop: ["a"] })).toEqual({ stop: ["a"] });
      expect(from({ stop: ["a", "b", "c", "d"] })).toEqual({ stop: ["a", "b", "c", "d"] });
    });

    it.each([
      "",
      [],
      ["a", "b", "c", "d", "e"],
      ["a", ""],
      ["a", 1],
      [["a"]],
      5,
      null,
      {},
    ])("drops %j", (value) => {
      expect(from({ stop: value })).toEqual({});
    });
  });

  describe("seed", () => {
    it.each([0, 42, -7])("accepts the integer %s", (value) => {
      expect(from({ seed: value })).toEqual({ seed: value });
    });

    it("accepts the largest and smallest safe integers", () => {
      expect(from({ seed: Number.MAX_SAFE_INTEGER })).toEqual({ seed: Number.MAX_SAFE_INTEGER });
      expect(from({ seed: Number.MIN_SAFE_INTEGER })).toEqual({ seed: Number.MIN_SAFE_INTEGER });
    });

    it.each([1.5, NaN, Infinity, "42", null, true, 2 ** 53, -(2 ** 53), 1e21])("drops %j", (value) => {
      expect(from({ seed: value })).toEqual({});
    });
  });

  describe.each(["presence_penalty", "frequency_penalty"])("%s", (key) => {
    it.each([-2, -0.5, 0, 1.25, 2])("accepts %s", (value) => {
      expect(from({ [key]: value })).toEqual({ [key]: value });
    });

    it.each([-2.01, 2.01, 10, NaN, Infinity, "1", null])("drops %j", (value) => {
      expect(from({ [key]: value })).toEqual({});
    });
  });

  describe("response_format", () => {
    it("accepts an object whose type is a string, and passes it on untouched", () => {
      const format = { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } };
      expect(from({ response_format: format })).toEqual({ response_format: format });
      expect(from({ response_format: { type: "json_object" } })).toEqual({
        response_format: { type: "json_object" },
      });
    });

    it.each([{}, { type: 1 }, { type: null }, "json_object", null, [], [{ type: "text" }], 5])(
      "drops %j",
      (value) => {
        expect(from({ response_format: value })).toEqual({});
      }
    );
  });

  it("forwards every valid parameter together and drops only the bad ones", () => {
    expect(
      from({
        max_tokens: 100,
        top_p: 2,
        stop: ["x"],
        seed: 1,
        presence_penalty: 0.5,
        frequency_penalty: 9,
        response_format: { type: "text" },
      })
    ).toEqual({
      max_tokens: 100,
      stop: ["x"],
      seed: 1,
      presence_penalty: 0.5,
      response_format: { type: "text" },
    });
  });
});
