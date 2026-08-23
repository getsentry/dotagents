import { describe, expect, it } from "vitest";
import { isSerializedObject, isSerializedValue, type SerializedObject } from "./serialized.js";

describe("serialized values", () => {
  it("accepts recursively serializable documents", () => {
    expect(isSerializedObject({
      enabled: true,
      nested: { values: ["one", 2, null] },
      optional: undefined,
      timestamp: new Date("2026-01-01T00:00:00Z"),
    })).toBe(true);
  });

  it("rejects values that cannot cross a serialization boundary", () => {
    expect(isSerializedValue({ callback: () => null })).toBe(false);
    expect(isSerializedValue({ count: 1n })).toBe(false);
    expect(isSerializedValue(Symbol("value"))).toBe(false);
    expect(isSerializedValue(Number.NaN)).toBe(false);
    expect(isSerializedValue(new Date("invalid"))).toBe(false);
    const invalidDate = new Date("invalid");
    invalidDate.getTime = () => 0;
    expect(isSerializedValue(invalidDate)).toBe(false);
    const hiddenCallback = Object.defineProperty({}, "callback", { value: () => null });
    expect(isSerializedValue(hiddenCallback)).toBe(false);
    const accessor = Object.defineProperty({}, "enabled", { get: () => true, enumerable: true });
    expect(isSerializedValue(accessor)).toBe(false);
    expect(isSerializedValue(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(false);
    expect(isSerializedValue(new Map([["enabled", true]]))).toBe(false);
    expect(isSerializedValue(new (class Metadata { enabled = true; })())).toBe(false);
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(isSerializedValue(sparse)).toBe(false);
  });

  it("rejects cyclic objects without overflowing", () => {
    interface CyclicValue { self?: object }
    const value: CyclicValue = {};
    value.self = value;
    expect(isSerializedObject(value)).toBe(false);
  });

  it("rejects excessive nesting without overflowing", () => {
    let value: SerializedObject = {};
    for (let depth = 0; depth < 20_000; depth++) {
      value = { nested: value };
    }
    expect(isSerializedObject(value)).toBe(false);
  });
});
