export type SerializedValue =
  | string
  | number
  | boolean
  | null
  | Date
  | SerializedValue[]
  | SerializedObject;

export interface SerializedObject {
  [key: string]: SerializedValue | undefined;
}

export function isSerializedObject(value: unknown): value is SerializedObject {
  try {
    return isPlainObject(value) && validateSerializedValue(value);
  } catch {
    return false;
  }
}

export function isSerializedValue(value: unknown): value is SerializedValue {
  try {
    return validateSerializedValue(value);
  } catch {
    return false;
  }
}

interface VisitFrame {
  value: unknown;
  exiting: boolean;
}

function validateSerializedValue(root: unknown): boolean {
  const ancestors = new Set<object>();
  const stack: VisitFrame[] = [{ value: root, exiting: false }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const value = frame.value;
    if (frame.exiting) {
      ancestors.delete(value as object);
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {continue;}
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {return false;}
      continue;
    }
    if (value instanceof Date) {
      if (
        Object.getPrototypeOf(value) !== Date.prototype ||
        Reflect.ownKeys(value).length > 0 ||
        Number.isNaN(Date.prototype.getTime.call(value))
      ) {
        return false;
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value) || Reflect.ownKeys(value).length !== value.length + 1) {return false;}
      ancestors.add(value);
      stack.push({ value, exiting: true });
      for (let index = value.length - 1; index >= 0; index--) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !("value" in descriptor)) {return false;}
        stack.push({ value: descriptor.value, exiting: false });
      }
      continue;
    }
    if (!isPlainObject(value) || ancestors.has(value)) {return false;}
    ancestors.add(value);
    stack.push({ value, exiting: true });
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {return false;}
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {return false;}
      if (descriptor.value !== undefined) {
        stack.push({ value: descriptor.value, exiting: false });
      }
    }
  }

  return true;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
