import { Refusal } from './errors.js';

export const COUNTER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const COUNTER_STYLES = ['decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'];

export function counterName(classNames) {
  const names = String(classNames || '').split(/\s+/).filter((name) => name.startsWith('wc-count-'));
  if (!names.length) return null;
  if (names.length !== 1 || !COUNTER_NAME.test(names[0].slice(9))) {
    throw new Refusal('bad-counter', `invalid counter class "${names.join(' ')}"`);
  }
  return names[0].slice(9);
}

export function parseCounterDeclarations(lines, where) {
  const declarations = Object.create(null);
  for (const line of lines) {
    const match = /^  ([a-z][a-z0-9]*(?:-[a-z0-9]+)*):\s*\{(.*)\}\s*(?:#.*)?$/.exec(line);
    if (!match) throw new Refusal('bad-counter', `invalid counter declaration "${line}"`, where);
    const [, name, fields] = match;
    if (Object.hasOwn(declarations, name)) throw new Refusal('bad-counter', `counter "${name}" is declared twice`, where);
    const values = Object.create(null);
    for (const field of fields.split(',')) {
      const pair = /^\s*(start|style)\s*:\s*([a-z0-9-]+)\s*$/.exec(field);
      if (!pair || Object.hasOwn(values, pair[1])) throw new Refusal('bad-counter', `invalid fields for counter "${name}"`, where);
      values[pair[1]] = pair[2];
    }
    const start = Number(values.start);
    if (!/^[1-9]\d*$/.test(values.start || '') || !Number.isSafeInteger(start)) {
      throw new Refusal('bad-counter', `counter "${name}" needs a positive integer start`, where);
    }
    if (!COUNTER_STYLES.includes(values.style)) throw new Refusal('bad-counter', `counter "${name}" has unknown style "${values.style || ''}"`, where);
    if (values.style.endsWith('-roman') && start > 3999) throw new Refusal('bad-counter', `roman counter "${name}" must start at 3999 or less`, where);
    declarations[name] = { start, style: values.style };
  }
  if (!lines.length) throw new Refusal('bad-counter', 'counters must declare at least one counter', where);
  return declarations;
}

export function parseCounterInput(text, where) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => `  ${line}`);
  return lines.length ? parseCounterDeclarations(lines, where) : null;
}

export function counterFrontmatterLines(declarations) {
  return Object.entries(declarations || {}).map(([name, value]) => `  ${name}: { start: ${value.start}, style: ${value.style} }`);
}

function numeral(value, style, name, where) {
  if (style === 'decimal') return String(value);
  if (style.endsWith('-alpha')) {
    let result = '';
    while (value > 0) {
      value--;
      result = String.fromCharCode(97 + value % 26) + result;
      value = Math.floor(value / 26);
    }
    return style === 'upper-alpha' ? result.toUpperCase() : result;
  }
  if (value > 3999) throw new Refusal('bad-counter', `roman counter "${name}" exceeds 3999`, where);
  const symbols = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let result = '';
  for (const [amount, symbol] of symbols) {
    while (value >= amount) {
      result += symbol;
      value -= amount;
    }
  }
  return style === 'lower-roman' ? result.toLowerCase() : result;
}

export function counterResolver(declarations, where) {
  const next = Object.create(null);
  return (name) => {
    if (!declarations || !Object.hasOwn(declarations, name)) throw new Refusal('undeclared-counter', `counter "${name}" is not declared`, where);
    const definition = declarations[name];
    if (!COUNTER_STYLES.includes(definition.style)) throw new Refusal('bad-counter', `counter "${name}" has unknown style "${definition.style}"`, where);
    const value = next[name] ?? definition.start;
    if (!Number.isSafeInteger(value)) throw new Refusal('bad-counter', `counter "${name}" exceeds the supported integer range`, where);
    next[name] = value + 1;
    return numeral(value, definition.style, name, where);
  };
}
