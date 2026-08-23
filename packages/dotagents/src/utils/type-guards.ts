export interface ErrorWithCode extends Error {
  code: string | number;
}

export function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string";
}

export function isNonEmptyString<Value>(value: Value): value is Value & string {
  return typeof value === "string" && value.length > 0;
}

export function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number";
}

export function isObject<Value>(value: Value): value is Value & object {
  return typeof value === "object" && value !== null;
}

export function isStringArray<Value>(value: Value): value is Value & string[] {
  return Array.isArray(value) && value.every(isString);
}

export function hasErrorCode<Value>(value: Value, code: string): value is Value & ErrorWithCode {
  return value instanceof Error && "code" in value && value.code === code;
}
