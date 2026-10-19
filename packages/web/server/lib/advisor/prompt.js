// The model-facing half of the advisor: how the Small Model is asked to read a
// turn's file changes and how its answer is read back. Tolerant parsing keeps
// a malformed reply from discarding the deterministic findings — the rules and
// anchor passes land first, and the model pass can only add to them.

import { isPlainObject, isString } from '../shared/guards.js';
import { buildReviewDigest } from './records.js';

const NOTE_CHAR_LIMIT = 240;
const FILE_CHAR_LIMIT = 300;
const MAX_MODEL_FINDINGS = 6;
const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];

const hasCyrillic = (text) => /[\u0400-\u04FF]/.test(text);

const buildAdvisorSystemPrompt = (language) => [
  'You review the file changes one agent turn made, listed below.',
  'Report only defects the changes introduce or fail to fix: code that cannot work as written,',
  'a broken invariant of the surrounding code, a security problem, a change that contradicts',
  'what the turn claims it did, or an obvious error left behind.',
  'Do not report style, naming, possible future problems, or anything the change does not touch.',
  'Every finding names the file and, when the digest shows enough context, the line or symbol.',
  `Write every finding in ${language}. Keep each finding to one sentence.`,
  'Answer with a JSON array only. Each item is an object with the keys',
  `"severity" (one of ${JSON.stringify(SEVERITIES)}), "note" (the sentence), and "file" (the path from the digest).`,
  '"P0" is a change that breaks what it touches; "P1" a defect that must be fixed;',
  '"P2" likely a defect; "P3" a doubt worth naming.',
  'An empty array is the correct answer when the change holds up.',
].join(' ');

export const buildAdvisorPrompt = ({ records, humanText }) => {
  const digest = buildReviewDigest(records);
  if (!digest) return null;
  const language = hasCyrillic(humanText) ? 'Russian' : 'English';
  const context = humanText ? `The user's request for the turn:\n${humanText.slice(0, 4_000)}\n\n` : '';
  return {
    system: buildAdvisorSystemPrompt(language),
    prompt: `${context}The turn's file changes, newest last:\n\n${digest}`,
    language,
  };
};

const validSeverity = (value) => (SEVERITIES.includes(value) ? value : 'P2');

const trimTo = (value, limit) => (isString(value) && value.trim() ? value.trim().slice(0, limit) : '');

/**
 * The first JSON array in the reply, however it is fenced or padded. Items
 * without a note are dropped rather than guessed at; unknown fields are
 * ignored. Cap: the model cannot out-shout the deterministic passes.
 */
export function parseModelFindings(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const findings = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    const note = trimTo(item.note, NOTE_CHAR_LIMIT);
    if (!note) continue;
    findings.push({
      severity: validSeverity(item.severity),
      source: 'model',
      note,
      file: trimTo(item.file, FILE_CHAR_LIMIT) || undefined,
    });
    if (findings.length >= MAX_MODEL_FINDINGS) break;
  }
  return findings;
}
