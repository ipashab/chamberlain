// Anchor verification: the read-back the edit tool cannot give mid-turn.
// After the turn ends, the last change to each file is re-checked against the
// file on disk — the new text there, the old text gone. Reading the tool's own
// records (not a git diff) keeps the check scoped to what this session did;
// other sessions may edit the same working tree, and a git diff cannot tell
// their changes from this turn's.

import { lastRecordPerFile } from './records.js';

const FILE_CHAR_LIMIT = 300;

const displayPath = (resolvedPath) =>
  resolvedPath.length > FILE_CHAR_LIMIT ? resolvedPath.slice(0, FILE_CHAR_LIMIT) : resolvedPath;

/**
 * `readFile` returns the file's current text, `null` when the file is gone,
 * and throws on anything else. A file nobody can read is not a violation:
 * the check is skipped, not failed. `resolvePath` maps a tool-written path
 * (often relative) to the file the session's directory is working in.
 */
export async function verifyAnchors({ records, readFile, resolvePath, signal }) {
  const findings = [];
  const last = lastRecordPerFile(records);
  await Promise.all([...last.values()].map(async (record) => {
    const resolved = resolvePath(record.path);
    let content;
    try {
      content = await readFile(resolved);
    } catch {
      return;
    }
    if (content === null) {
      findings.push({
        severity: 'P1',
        source: 'anchor',
        note: `The ${record.kind} changed ${displayPath(record.path)}, but the file is gone from disk.`,
        file: record.path,
      });
      return;
    }
    if (record.kind === 'edit') verifyEditAnchor(record, content, findings);
    if (record.kind === 'write') verifyWriteAnchor(record, content, findings);
  }));
  signal.throwIfAborted();
  // Promise.all finishes in call order, not record order; findings are
  // sorted back into the turn's order so P1s do not jitter between turns.
  const order = new Map(records.map((record, index) => [record.path, index]));
  findings.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));
  return findings;
}

function verifyEditAnchor(record, content, findings) {
  const { oldString, newString } = record;
  // A deletion edit: the anchor is the absence of the old text.
  if (newString === '') {
    if (content.includes(oldString)) {
      findings.push({
        severity: 'P1',
        source: 'anchor',
        note: `The turn deleted text from ${displayPath(record.path)}, but it is still in the file.`,
        file: record.path,
      });
    }
    return;
  }
  const present = content.includes(newString);
  if (present) return;
  // The old string may legitimately survive elsewhere (a duplicate match the
  // edit left alone), so only the two-way miss versus hit decides the story.
  const oldPresent = oldString !== '' && content.includes(oldString);
  if (oldPresent) {
    findings.push({
      severity: 'P1',
      source: 'anchor',
      note: `The last edit to ${displayPath(record.path)} did not take: the old text is still in the file.`,
      file: record.path,
    });
  } else {
    findings.push({
      severity: 'P2',
      source: 'anchor',
      note: `Neither the old nor the new text of the last edit to ${displayPath(record.path)} is in the file; that spot was rewritten afterwards.`,
      file: record.path,
    });
  }
}

function verifyWriteAnchor(record, content, findings) {
  if (content === record.content) return;
  findings.push({
    severity: 'P2',
    source: 'anchor',
    note: `The file on disk differs from the content the turn wrote to ${displayPath(record.path)}.`,
    file: record.path,
  });
}
