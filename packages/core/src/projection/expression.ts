import jsep from 'jsep';
import type {
  BinaryExpression,
  CallExpression,
  ConditionalExpression,
  Expression,
  HookScope,
  Identifier,
  Literal,
  MemberExpression,
  UnaryExpression,
} from 'jsep';

export type ProjectionCompileErrorCode =
  | 'PROJECTION_YAML_INVALID'
  | 'PROJECTION_SPEC_INVALID'
  | 'PROJECTION_TABLE_DUPLICATE'
  | 'PROJECTION_ANCHOR_INVALID'
  | 'PROJECTION_STATE_SCOPE_INVALID'
  | 'PROJECTION_VERSION_REQUIRED'
  | 'PROJECTION_PARENT_KEY_INVALID'
  | 'PROJECTION_DISSECT_INVALID'
  | 'PROJECTION_PARSER_UNKNOWN'
  | 'PROJECTION_DISSECT_CYCLE'
  | 'EXPRESSION_PARSE_ERROR'
  | 'EXPRESSION_NODE_FORBIDDEN'
  | 'EXPRESSION_CALL_FORBIDDEN'
  | 'EXPRESSION_IDENTIFIER_FORBIDDEN'
  | 'EXPRESSION_MEMBER_FORBIDDEN'
  | 'EXPRESSION_STATE_UNDECLARED';

export class ProjectionCompileError extends Error {
  readonly code: ProjectionCompileErrorCode;
  readonly path: string;

  constructor(code: ProjectionCompileErrorCode, path: string, detail: string) {
    super(`${code} at ${path}: ${detail}`);
    this.name = 'ProjectionCompileError';
    this.code = code;
    this.path = path;
  }
}

export interface CompiledExpression {
  readonly source: string;
}

export interface ExpressionContext {
  readonly _: unknown;
  readonly _root?: unknown;
  readonly _parent?: unknown;
  readonly indexes?: readonly number[];
  readonly state?: Readonly<Record<string, unknown>>;
}

const compiledAsts = new WeakMap<CompiledExpression, Expression>();

const binaryOperators = new Set([
  '||',
  'or',
  '&&',
  'and',
  '|',
  '^',
  '&',
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  '<<',
  '>>',
  '>>>',
  '+',
  '-',
  '*',
  '/',
  '%',
]);
const unaryOperators = new Set(['-', '+', '!', 'not', '~']);
const builtinNames = new Set(['enum_str', 'to_i', 'len', 'u24be']);
const contextIdentifierNames = new Set(['_', '_root', '_parent']);
const expressionTokenNames = new Set(['true', 'false', 'null', 'and', 'or', 'not', 'this']);
const forbiddenIdentifiers = new Set([
  '__proto__',
  'Array',
  'BigInt',
  'Boolean',
  'Date',
  'Function',
  'JSON',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'Reflect',
  'RegExp',
  'String',
  'Symbol',
  'WebAssembly',
  'constructor',
  'eval',
  'exports',
  'global',
  'globalThis',
  'module',
  'process',
  'prototype',
  'require',
  'undefined',
  'window',
]);
const forbiddenMemberNames = new Set(['__proto__', 'constructor', 'prototype']);
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const isProjectionStateName = (name: string): boolean =>
  identifierPattern.test(name) &&
  !forbiddenIdentifiers.has(name) &&
  !contextIdentifierNames.has(name) &&
  !expressionTokenNames.has(name) &&
  !builtinNames.has(name) &&
  name !== '_index';

jsep.addBinaryOp('or', 1);
jsep.addBinaryOp('and', 2);
jsep.addUnaryOp('not');

const hexDigitPattern = /[0-9a-fA-F]/;

// jsep does not parse 0x literals; gobble them before its number tokenizer runs.
jsep.hooks.add('gobble-token', function (this: HookScope, env: { node?: unknown }) {
  if (this.expr.charAt(this.index) !== '0') return;
  const marker = this.expr.charAt(this.index + 1);
  if (marker !== 'x' && marker !== 'X') return;

  let cursor = this.index + 2;
  while (cursor < this.expr.length && hexDigitPattern.test(this.expr.charAt(cursor))) cursor += 1;
  if (cursor === this.index + 2) this.throwError('Expected hexadecimal digits after 0x');

  const raw = this.expr.slice(this.index, cursor);
  this.index = cursor;
  const wide = BigInt(raw);
  const value = wide <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(wide) : wide;
  env.node = { type: 'Literal', value, raw } as unknown as Literal;
});

const expressionError = (code: ProjectionCompileErrorCode, detail: string): ProjectionCompileError =>
  new ProjectionCompileError(code, 'expression', detail);

const validateIdentifier = (node: Identifier, asCallee = false): void => {
  if (!identifierPattern.test(node.name) || forbiddenIdentifiers.has(node.name)) {
    throw expressionError(
      'EXPRESSION_IDENTIFIER_FORBIDDEN',
      `identifier ${JSON.stringify(node.name)} is not available`,
    );
  }
  if (
    !asCallee &&
    (builtinNames.has(node.name) || expressionTokenNames.has(node.name) || node.name === '_index')
  ) {
    throw expressionError(
      'EXPRESSION_IDENTIFIER_FORBIDDEN',
      `identifier ${JSON.stringify(node.name)} is reserved by the expression evaluator`,
    );
  }
};

const validateMember = (node: MemberExpression): void => {
  if (node.computed || node.property.type !== 'Identifier') {
    throw expressionError(
      'EXPRESSION_MEMBER_FORBIDDEN',
      'only non-computed identifier member access is allowed',
    );
  }

  const property = node.property as Identifier;
  if (forbiddenMemberNames.has(property.name)) {
    throw expressionError(
      'EXPRESSION_MEMBER_FORBIDDEN',
      `member ${JSON.stringify(property.name)} is not available`,
    );
  }

  validateNode(node.object);
};

const validateCall = (node: CallExpression): void => {
  if (node.callee.type !== 'Identifier') {
    throw expressionError(
      'EXPRESSION_NODE_FORBIDDEN',
      'only direct calls to the closed function set are allowed',
    );
  }

  const callee = node.callee as Identifier;
  validateIdentifier(callee, true);
  if (callee.name !== '_index' && !builtinNames.has(callee.name)) {
    throw expressionError(
      'EXPRESSION_CALL_FORBIDDEN',
      `call to ${JSON.stringify(callee.name)} is not available`,
    );
  }
  if (node.arguments.length !== 1) {
    throw expressionError('EXPRESSION_CALL_FORBIDDEN', `${callee.name} expects exactly one argument`);
  }

  for (const argument of node.arguments) {
    validateNode(argument);
  }
};

const validateNode = (node: Expression): void => {
  switch (node.type) {
    case 'Literal': {
      const value = (node as Literal).value;
      if (
        value !== null &&
        typeof value !== 'boolean' &&
        typeof value !== 'number' &&
        typeof value !== 'bigint' &&
        typeof value !== 'string'
      ) {
        throw expressionError(
          'EXPRESSION_NODE_FORBIDDEN',
          'only null, boolean, number, and string literals are allowed',
        );
      }
      return;
    }
    case 'Identifier':
      validateIdentifier(node as Identifier);
      return;
    case 'MemberExpression':
      validateMember(node as MemberExpression);
      return;
    case 'UnaryExpression': {
      const unary = node as UnaryExpression;
      if (!unaryOperators.has(unary.operator)) {
        throw expressionError(
          'EXPRESSION_NODE_FORBIDDEN',
          `unary operator ${JSON.stringify(unary.operator)} is not allowed`,
        );
      }
      validateNode(unary.argument);
      return;
    }
    case 'BinaryExpression': {
      const binary = node as BinaryExpression;
      if (!binaryOperators.has(binary.operator)) {
        throw expressionError(
          'EXPRESSION_NODE_FORBIDDEN',
          `binary operator ${JSON.stringify(binary.operator)} is not allowed`,
        );
      }
      validateNode(binary.left);
      validateNode(binary.right);
      return;
    }
    case 'ConditionalExpression': {
      const conditional = node as ConditionalExpression;
      validateNode(conditional.test);
      validateNode(conditional.consequent);
      validateNode(conditional.alternate);
      return;
    }
    case 'CallExpression':
      validateCall(node as CallExpression);
      return;
    default:
      throw expressionError(
        'EXPRESSION_NODE_FORBIDDEN',
        `AST node ${JSON.stringify(node.type)} is not allowed`,
      );
  }
};

export const compileExpression = (source: string): CompiledExpression => {
  let ast: Expression;
  try {
    ast = jsep(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw expressionError('EXPRESSION_PARSE_ERROR', detail);
  }

  validateNode(ast);
  const compiled = Object.freeze({ source });
  compiledAsts.set(compiled, ast);
  return compiled;
};

const collectStateReferences = (node: Expression, references: Set<string>): void => {
  switch (node.type) {
    case 'Literal':
      return;
    case 'Identifier': {
      const name = (node as Identifier).name;
      if (!contextIdentifierNames.has(name)) references.add(name);
      return;
    }
    case 'MemberExpression':
      collectStateReferences((node as MemberExpression).object, references);
      return;
    case 'UnaryExpression':
      collectStateReferences((node as UnaryExpression).argument, references);
      return;
    case 'BinaryExpression': {
      const binary = node as BinaryExpression;
      collectStateReferences(binary.left, references);
      collectStateReferences(binary.right, references);
      return;
    }
    case 'ConditionalExpression': {
      const conditional = node as ConditionalExpression;
      collectStateReferences(conditional.test, references);
      collectStateReferences(conditional.consequent, references);
      collectStateReferences(conditional.alternate, references);
      return;
    }
    case 'CallExpression':
      for (const argument of (node as CallExpression).arguments) {
        collectStateReferences(argument, references);
      }
      return;
    default:
      return;
  }
};

export const getExpressionStateReferences = (expression: CompiledExpression): ReadonlySet<string> => {
  const ast = compiledAsts.get(expression);
  if (!ast) {
    throw expressionError('EXPRESSION_NODE_FORBIDDEN', 'expression was not produced by compileExpression');
  }

  const references = new Set<string>();
  collectStateReferences(ast, references);
  return references;
};

const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

const missingProperty = Symbol('missing property');

const readOwnDataProperty = (value: unknown, key: string): unknown | typeof missingProperty => {
  if (value === null || value === undefined) return missingProperty;

  const boxed = Object(value) as object;
  const descriptor = Object.getOwnPropertyDescriptor(boxed, key);
  if (!descriptor || !('value' in descriptor)) return missingProperty;
  return descriptor.value;
};

const snakeToCamel = (key: string): string =>
  key.replace(/_([a-z0-9])/gu, (_match, character: string) => character.toUpperCase());

const readMember = (value: unknown, key: string): unknown => {
  const exact = readOwnDataProperty(value, key);
  if (exact !== missingProperty) return exact ?? null;

  const camelKey = snakeToCamel(key);
  if (camelKey === key) return null;
  const camel = readOwnDataProperty(value, camelKey);
  return camel === missingProperty ? null : (camel ?? null);
};

const readIdentifier = (name: string, context: ExpressionContext): unknown => {
  if (name === '_') return context._ ?? null;
  if (name === '_root') return context._root ?? null;
  if (name === '_parent') return context._parent ?? null;

  const state = context.state;
  if (!state || !hasOwn(state, name)) return null;
  const value = readOwnDataProperty(state, name);
  return value === missingProperty ? null : (value ?? null);
};

type NumericPair = readonly [number, number] | readonly [bigint, bigint];

const numericPair = (left: unknown, right: unknown): NumericPair | null => {
  if (typeof left === 'number' && typeof right === 'number') return [left, right];
  if (typeof left === 'bigint' && typeof right === 'bigint') return [left, right];
  if (typeof left === 'bigint' && typeof right === 'number' && Number.isSafeInteger(right)) {
    return [left, BigInt(right)];
  }
  if (typeof left === 'number' && Number.isSafeInteger(left) && typeof right === 'bigint') {
    return [BigInt(left), right];
  }
  return null;
};

const evaluateArithmetic = (operator: string, left: unknown, right: unknown): unknown => {
  if (operator === '+' && (typeof left === 'string' || typeof right === 'string')) {
    return String(left) + String(right);
  }

  const pair = numericPair(left, right);
  if (!pair) return null;
  const [numericLeft, numericRight] = pair;

  if (typeof numericLeft === 'bigint' && typeof numericRight === 'bigint') {
    switch (operator) {
      case '+':
        return numericLeft + numericRight;
      case '-':
        return numericLeft - numericRight;
      case '*':
        return numericLeft * numericRight;
      case '/':
        return numericRight === 0n ? null : numericLeft / numericRight;
      case '%':
        return numericRight === 0n ? null : numericLeft % numericRight;
      case '|':
        return numericLeft | numericRight;
      case '^':
        return numericLeft ^ numericRight;
      case '&':
        return numericLeft & numericRight;
      case '<<':
        return numericLeft << numericRight;
      case '>>':
        return numericLeft >> numericRight;
      case '>>>':
        return BigInt.asUintN(64, numericLeft) >> numericRight;
      default:
        return null;
    }
  }

  const numberLeft = numericLeft as number;
  const numberRight = numericRight as number;
  switch (operator) {
    case '+':
      return numberLeft + numberRight;
    case '-':
      return numberLeft - numberRight;
    case '*':
      return numberLeft * numberRight;
    case '/':
      return numberLeft / numberRight;
    case '%':
      return numberLeft % numberRight;
    case '|':
      return numberLeft | numberRight;
    case '^':
      return numberLeft ^ numberRight;
    case '&':
      return numberLeft & numberRight;
    case '<<':
      return numberLeft << numberRight;
    case '>>':
      return numberLeft >> numberRight;
    case '>>>':
      return numberLeft >>> numberRight;
    default:
      return null;
  }
};

// Equality must agree with the ordering operators, which already compare mixed
// bigint/number operands numerically; strict identity would make them disagree.
const numericAwareEquals = (left: unknown, right: unknown): boolean => {
  if (
    (typeof left === 'bigint' && typeof right === 'number') ||
    (typeof left === 'number' && typeof right === 'bigint')
  ) {
    return left == right;
  }
  return left === right;
};

const evaluateBinary = (node: BinaryExpression, context: ExpressionContext): unknown => {
  const left = evaluateNode(node.left, context);
  if (node.operator === '&&' || node.operator === 'and') {
    return left ? evaluateNode(node.right, context) : left;
  }
  if (node.operator === '||' || node.operator === 'or') {
    return left ? left : evaluateNode(node.right, context);
  }

  const right = evaluateNode(node.right, context);
  if (left === null || left === undefined || right === null || right === undefined) {
    return null;
  }

  switch (node.operator) {
    case '==':
    case '===':
      return numericAwareEquals(left, right);
    case '!=':
    case '!==':
      return !numericAwareEquals(left, right);
    case '<':
      return left < right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    default:
      return evaluateArithmetic(node.operator, left, right);
  }
};

const evaluateUnary = (node: UnaryExpression, context: ExpressionContext): unknown => {
  const value = evaluateNode(node.argument, context);
  if (node.operator === '!' || node.operator === 'not') return !value;
  if (value === null || value === undefined) return null;

  switch (node.operator) {
    case '+':
      return typeof value === 'bigint' ? value : Number(value);
    case '-':
      return typeof value === 'bigint' ? -value : -Number(value);
    case '~':
      return typeof value === 'bigint' ? ~value : ~Number(value);
    default:
      return null;
  }
};

const builtins = {
  enum_str: (value: unknown): unknown => (value == null ? null : String(value)),
  to_i: (value: unknown): unknown => (value == null ? null : Number(value)),
  len: (value: unknown): unknown => {
    if (value == null) return null;
    if (typeof value === 'string' || Array.isArray(value) || value instanceof Uint8Array) {
      return value.length;
    }
    const length = readOwnDataProperty(value, 'length');
    return length !== missingProperty && typeof length === 'number' ? length : null;
  },
  u24be: (value: unknown): unknown => {
    if (!(value instanceof Uint8Array) || value.length !== 3) return null;
    return (value[0]! << 16) | (value[1]! << 8) | value[2]!;
  },
} as const;

const evaluateCall = (node: CallExpression, context: ExpressionContext): unknown => {
  const callee = (node.callee as Identifier).name;
  const argument = evaluateNode(node.arguments[0]!, context);

  if (callee === '_index') {
    const indexes = context.indexes;
    if (
      !Array.isArray(indexes) ||
      typeof argument !== 'number' ||
      !Number.isSafeInteger(argument) ||
      argument < 0
    ) {
      return null;
    }

    const length = readOwnDataProperty(indexes, 'length');
    if (typeof length !== 'number' || argument >= length) return null;
    const value = readOwnDataProperty(indexes, String(argument));
    return value === missingProperty ? null : (value ?? null);
  }

  return builtins[callee as keyof typeof builtins](argument);
};

const evaluateNode = (node: Expression, context: ExpressionContext): unknown => {
  switch (node.type) {
    case 'Literal':
      return (node as Literal).value;
    case 'Identifier':
      return readIdentifier((node as Identifier).name, context);
    case 'MemberExpression': {
      const member = node as MemberExpression;
      return readMember(evaluateNode(member.object, context), (member.property as Identifier).name);
    }
    case 'UnaryExpression':
      return evaluateUnary(node as UnaryExpression, context);
    case 'BinaryExpression':
      return evaluateBinary(node as BinaryExpression, context);
    case 'ConditionalExpression': {
      const conditional = node as ConditionalExpression;
      return evaluateNode(conditional.test, context)
        ? evaluateNode(conditional.consequent, context)
        : evaluateNode(conditional.alternate, context);
    }
    case 'CallExpression':
      return evaluateCall(node as CallExpression, context);
    default:
      throw expressionError(
        'EXPRESSION_NODE_FORBIDDEN',
        `compiled AST contains forbidden node ${JSON.stringify(node.type)}`,
      );
  }
};

export const evaluateExpression = (expression: CompiledExpression, context: ExpressionContext): unknown => {
  const ast = compiledAsts.get(expression);
  if (!ast) {
    throw expressionError('EXPRESSION_NODE_FORBIDDEN', 'expression was not produced by compileExpression');
  }
  return evaluateNode(ast, context);
};
