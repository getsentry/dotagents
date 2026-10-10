interface ErrorWithCode extends Error {
  code: string | number;
}

export function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string";
}

export function isObject<Value>(value: Value): value is Value & object {
  return typeof value === "object" && value !== null;
}

export function hasErrorCode<Value>(value: Value, code: string): value is Value & ErrorWithCode {
  return value instanceof Error && "code" in value && value.code === code;
}
