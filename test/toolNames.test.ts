import { describe, expect, it } from "vitest";
import { MAX_TOOL_NAME_LENGTH, aliasToolName, createToolNameAliases } from "../src/toolNames";

const long = "mcp_" + "a".repeat(40) + "_" + "b".repeat(30); // 75 characters

describe("aliasToolName", () => {
  it("exposes the 64 character limit", () => {
    expect(MAX_TOOL_NAME_LENGTH).toBe(64);
  });

  it("leaves names of 64 characters or fewer untouched", () => {
    expect(aliasToolName("a".repeat(64))).toBe("a".repeat(64));
    expect(aliasToolName("run")).toBe("run");
  });

  it("shortens longer names to exactly 64 characters, deterministically", () => {
    const alias = aliasToolName(long);
    expect(alias).toHaveLength(64);
    expect(alias.startsWith(long.slice(0, 55) + "_")).toBe(true);
    expect(alias).toMatch(/_[0-9a-f]{8}$/);
    expect(aliasToolName(long)).toBe(alias);
  });

  it("gives different aliases to names that share their first 55 characters", () => {
    const a = "p".repeat(55) + "_first_tool";
    const b = "p".repeat(55) + "_second_tool";
    expect(aliasToolName(a)).not.toBe(aliasToolName(b));
  });

  it("honours a custom maximum length", () => {
    expect(aliasToolName("abcdefghijklmnopqrstuvwxyz", 20)).toHaveLength(20);
  });
});

describe("createToolNameAliases", () => {
  it("maps an alias back to the original name, and passes unknown names through", () => {
    const aliases = createToolNameAliases(["short", long]);
    const wire = aliases.toWire(long);
    expect(wire).toHaveLength(64);
    expect(aliases.fromWire(wire)).toBe(long);
    expect(aliases.toWire("short")).toBe("short");
    expect(aliases.fromWire("short")).toBe("short");
    expect(aliases.fromWire("never_registered")).toBe("never_registered");
  });

  it("aliases a name that was not registered up front", () => {
    const aliases = createToolNameAliases([]);
    expect(aliases.toWire(long)).toBe(aliasToolName(long));
  });
});

describe("createToolNameAliases with a colliding hash", () => {
  // A hash that gives every name the same digits forces the collision.
  const sameHash = () => "deadbeef";
  const a = "q".repeat(60) + "_alpha_tool";
  const b = "q".repeat(60) + "_beta_tool";

  it("gives two long names that hash alike two different aliases, each mapping back", () => {
    const aliases = createToolNameAliases([a, b], MAX_TOOL_NAME_LENGTH, sameHash);
    const wireA = aliases.toWire(a);
    const wireB = aliases.toWire(b);
    expect(wireA).toMatch(/_deadbeef$/); // the forced hash is the one in use
    expect(wireA).not.toBe(wireB);
    for (const wire of [wireA, wireB]) {
      expect(wire.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
      expect(wire).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    expect(aliases.fromWire(wireA)).toBe(a);
    expect(aliases.fromWire(wireB)).toBe(b);
  });

  it("keeps the alias it has today for the first name and answers the same each time", () => {
    const aliases = createToolNameAliases([a, b], MAX_TOOL_NAME_LENGTH, sameHash);
    expect(aliases.toWire(a)).toBe(`${a.slice(0, 55)}_deadbeef`);
    expect(aliases.toWire(a)).toBe(aliases.toWire(a));
    expect(aliases.toWire(b)).toBe(aliases.toWire(b));
  });

  it("separates three names and a name registered later", () => {
    const c = "q".repeat(60) + "_gamma_tool";
    const d = "q".repeat(60) + "_delta_tool";
    const aliases = createToolNameAliases([a, b, c], MAX_TOOL_NAME_LENGTH, sameHash);
    const wires = [a, b, c, d].map((name) => aliases.toWire(name));
    expect(wires[0]).toMatch(/_deadbeef$/);
    expect(new Set(wires).size).toBe(4);
    [a, b, c, d].forEach((name, i) => expect(aliases.fromWire(wires[i])).toBe(name));
  });

  it("keeps finding free aliases when the hash never helps", () => {
    const many = Array.from({ length: 40 }, (_, i) => "q".repeat(60) + `_tool_${i}`);
    const aliases = createToolNameAliases(many, MAX_TOOL_NAME_LENGTH, sameHash);
    const wires = many.map((name) => aliases.toWire(name));
    expect(new Set(wires).size).toBe(many.length);
    wires.forEach((wire, i) => {
      expect(wire.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
      expect(aliases.fromWire(wire)).toBe(many[i]);
    });
  });

  it("never hands a long name the wire name of a short tool", () => {
    const aliases = createToolNameAliases([a], MAX_TOOL_NAME_LENGTH, sameHash);
    const wireOfA = aliases.toWire(a);
    const shortTwin = createToolNameAliases([wireOfA, b], MAX_TOOL_NAME_LENGTH, sameHash);
    expect(shortTwin.toWire(wireOfA)).toBe(wireOfA);
    expect(shortTwin.toWire(b)).not.toBe(wireOfA);
  });
});
