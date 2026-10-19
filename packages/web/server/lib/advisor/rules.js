// Deterministic violation rules over the text a turn added to files, plus the
// user's own rules from `advisor-rules.json` in the data directory. The rules
// pass needs no model and runs even when the Small Model is unavailable; the
// anchor pass in `anchors.js` and the model review in `prompt.js` order it.

import { isPlainObject, isString } from '../shared/guards.js';
import { addedText } from './records.js';

const FLAG_WHITELIST = new Set(['i', 'm', 's', 'u']);
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);

const stripLeadingDot = (extension) => (extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`);

const extensionOf = (filePath) => {
  const name = filePath.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
};

/**
 * High-precision defaults only: every pattern here is never wanted in a
 * change, in any project. Anything project-specific belongs in the user's
 * `advisor-rules.json`, not in the defaults.
 */
export const DEFAULT_RULES = [
  {
    id: 'type-ignore',
    pattern: String.raw`#\s*type:\s*ignore\b`,
    flags: '',
    severity: 'P2',
    message: 'A type error was suppressed with a type-ignore comment.',
  },
  {
    id: 'noqa',
    pattern: String.raw`#\s*noqa\b`,
    flags: '',
    severity: 'P3',
    message: 'A linter finding was suppressed with a noqa comment.',
  },
  {
    id: 'eslint-disable',
    pattern: String.raw`eslint-disable\b`,
    flags: '',
    severity: 'P3',
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
    message: 'A lint rule was disabled inline.',
  },
  {
    id: 'console-log',
    pattern: String.raw`console\.log\(`,
    flags: '',
    severity: 'P3',
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
    message: 'A console.log was left in the change.',
  },
  {
    id: 'debugger',
    pattern: String.raw`^\s*debugger;?\s*$`,
    flags: 'm',
    severity: 'P1',
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
    message: 'A debugger statement was left in the change.',
  },
  {
    id: 'breakpoint',
    pattern: String.raw`^\s*breakpoint\(\)\s*$`,
    flags: 'm',
    severity: 'P1',
    extensions: ['.py'],
    message: 'A breakpoint() call was left in the change.',
  },
  {
    id: 'pdb-set-trace',
    pattern: String.raw`\bpdb\.set_trace\(`,
    flags: '',
    severity: 'P1',
    extensions: ['.py'],
    message: 'A pdb.set_trace call was left in the change.',
  },
  {
    id: 'except-pass',
    pattern: String.raw`except[^\n:]*:\s*(#[^\n]*)?\n\s*pass\b`,
    flags: '',
    severity: 'P2',
    extensions: ['.py'],
    message: 'An except branch swallows the error with a bare pass.',
  },
  {
    id: 'bare-except',
    pattern: String.raw`^\s*except[^:\n]*:\s*$`,
    flags: 'm',
    severity: 'P2',
    extensions: ['.py'],
    message: 'A bare except catches and drops every error.',
  },
];

/**
 * User rules arrive as parsed JSON; a malformed entry is skipped, not thrown:
 * one bad line in `advisor-rules.json` must not turn the whole rules pass off.
 * Returns the compiled rules and a one-line reason for every skipped entry.
 */
export function compileUserRules(raw) {
  const compiled = [];
  const rejected = [];
  if (!Array.isArray(raw)) {
    return { compiled, rejected: ['the file must hold a JSON array'] };
  }
  for (const [index, entry] of raw.entries()) {
    if (!isPlainObject(entry)) {
      rejected.push(`entry ${index} is not an object`);
      continue;
    }
    const { pattern, flags = '', message = '', severity = 'P3', extensions = null } = entry;
    if (!isString(pattern) || !pattern.trim()) {
      rejected.push(`entry ${index} has no pattern`);
      continue;
    }
    if (!isString(flags) || [...flags].some((flag) => !FLAG_WHITELIST.has(flag))) {
      rejected.push(`entry ${index} has unsupported flags`);
      continue;
    }
    if (!SEVERITIES.has(severity)) {
      rejected.push(`entry ${index} has severity "${String(severity)}", expected P0-P3`);
      continue;
    }
    if (!isString(message) || !message.trim()) {
      rejected.push(`entry ${index} has no message`);
      continue;
    }
    const allowedExtensions = Array.isArray(extensions)
      ? extensions.filter((item) => isString(item) && item.trim()).map(stripLeadingDot)
      : null;
    try {
      compiled.push({
        id: `user-${index}`,
        regex: new RegExp(pattern, flags),
        severity,
        message: message.slice(0, 300),
        extensions: allowedExtensions?.length ? allowedExtensions : null,
      });
    } catch {
      rejected.push(`entry ${index} pattern does not compile`);
    }
  }
  return { compiled, rejected };
}

const ruleMatches = (rule, path) => {
  if (!rule.extensions) return true;
  const extension = extensionOf(path);
  return rule.extensions.includes(extension);
};

/**
 * One finding per (rule, file): a rule that hits many times in one file says
 * the same thing every time. Returns findings in rule order, then file order.
 */
export function applyRules(records, userRules = []) {
  const defaultRegexes = DEFAULT_RULES.map((rule) => ({
    ...rule,
    regex: new RegExp(rule.pattern, rule.flags),
  }));
  const seen = new Set();
  const findings = [];
  const check = (rule, record) => {
    if (!ruleMatches(rule, record.path)) return;
    const text = addedText(record);
    if (!text || !rule.regex.test(text)) return;
    const key = `${rule.id}|${record.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      severity: rule.severity,
      source: 'rules',
      note: rule.message,
      file: record.path,
    });
  };
  for (const rule of defaultRegexes) {
    for (const record of records) check(rule, record);
  }
  for (const rule of userRules) {
    for (const record of records) check(rule, record);
  }
  return findings;
}
