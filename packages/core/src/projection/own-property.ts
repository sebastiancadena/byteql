// Own-data-property reads shared by anchor traversal and the expression evaluator. Both avoid the
// prototype chain and accessors, so a parsed tree can never trigger inherited or getter-based code.

export const missingProperty = Symbol('missing property');

/** Reads an own data property of an object or function; `missingProperty` for anything else. */
export const readOwnDataProperty = (value: unknown, key: string): unknown | typeof missingProperty => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return missingProperty;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : missingProperty;
};

/**
 * Like `readOwnDataProperty`, but a primitive is boxed first so its own properties (a string's
 * `length` and indexes) are readable. Only `null`/`undefined` are missing.
 */
export const readOwnDataPropertyBoxed = (value: unknown, key: string): unknown | typeof missingProperty => {
  if (value === null || value === undefined) return missingProperty;
  return readOwnDataProperty(Object(value), key);
};
