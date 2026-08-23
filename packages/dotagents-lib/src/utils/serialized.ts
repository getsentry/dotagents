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

const MAX_SERIALIZED_DEPTH = 1_000;

export function isSerializedObject<Value>(value: Value): value is Value & SerializedObject {
  try {
    return isPlainObject(value) && validateSerializedValue(value);
  } catch {
    return false;
  }
}

export function isSerializedValue<Value>(value: Value): value is Value & SerializedValue {
  try {
    return validateSerializedValue(value);
  } catch {
    return false;
  }
}

interface VisitFrame {
  value: unknown;
  exiting: boolean;
  depth: number;
}

function validateSerializedValue<Value>(root: Value): root is Value & SerializedValue {
  const ancestors = new Set<object>();
  const stack: VisitFrame[] = [{ value: root, exiting: false, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {break;}
    const value = frame.value;
    if (frame.exiting) {
      // SAFETY: exiting frames are only pushed for arrays and plain objects.
      ancestors.delete(value as object);
      continue;
    }
    if (frame.depth > MAX_SERIALIZED_DEPTH) {return false;}
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
      stack.push({ value, exiting: true, depth: frame.depth });
      for (let index = value.length - 1; index >= 0; index--) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !("value" in descriptor)) {return false;}
        stack.push({ value: descriptor.value, exiting: false, depth: frame.depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(value) || ancestors.has(value)) {return false;}
    ancestors.add(value);
    stack.push({ value, exiting: true, depth: frame.depth });
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__") {return false;}
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {return false;}
      if (descriptor.value !== undefined) {
        stack.push({ value: descriptor.value, exiting: false, depth: frame.depth + 1 });
      }
    }
  }

  return true;
}

function isPlainObject<Value>(value: Value): value is Value & object {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
