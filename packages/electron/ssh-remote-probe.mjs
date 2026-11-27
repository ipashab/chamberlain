// The remote machine's environment and the probes that inspect it over a
// live SSH session. The paths describe where a user install of the tools can
// live on the remote side; each probe takes a runner, a closure the caller
// provides that sends the script through the connected session's control
// socket, so this module holds no session state of its own.

export const REMOTE_USER_PREFIX = '$HOME/.openchamber/npm-global';
export const REMOTE_BUN_CANDIDATE = '"${BUN_INSTALL:-$HOME/.bun}/bin/bun"';
export const REMOTE_NVM_BIN = '${NVM_DIR:-$HOME/.nvm}/versions/node/v$(ls -1 "${NVM_DIR:-$HOME/.nvm}/versions/node" 2>/dev/null | sed "s/^v//" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)/bin';
export const REMOTE_OPENCODE_CANDIDATES = [
  '"${OPENCODE_BINARY:-}"',
  '"$HOME/.opencode/bin/opencode"',
  '"${BUN_INSTALL:-$HOME/.bun}/bin/opencode"',
  '"${XDG_CACHE_HOME:-$HOME/.cache}/.bun/bin/opencode"',
  '"$HOME/.local/bin/opencode"',
  '"$HOME/.openchamber/npm-global/bin/opencode"',
  `"${REMOTE_NVM_BIN}/opencode"`,
];
export const REMOTE_PATH_PREFIX = `$HOME/.opencode/bin:\${BUN_INSTALL:-$HOME/.bun}/bin:\${XDG_CACHE_HOME:-$HOME/.cache}/.bun/bin:$HOME/.local/bin:$HOME/.openchamber/npm-global/bin:${REMOTE_NVM_BIN}`;
export const REMOTE_BIN_CANDIDATES = [
  '"$HOME/.openchamber/npm-global/bin/openchamber"',
  '"${BUN_INSTALL:-$HOME/.bun}/bin/openchamber"',
  '"${XDG_CACHE_HOME:-$HOME/.cache}/.bun/bin/openchamber"',
];

/**
 * Prints the first candidate that is an existing executable file: the
 * explicit candidates first, then whatever `command -v` resolves to.
 */
export const findRemoteTool = async (runRemote, commandName, extraCandidates = []) => {
  const candidateList = [...extraCandidates, `"$(command -v ${commandName} 2>/dev/null)"`].join(' ');
  const script = [
    `for candidate in ${candidateList}; do`,
    '  [ -f "$candidate" ] && [ -x "$candidate" ] || continue;',
    `  printf '%s' "$candidate";`,
    '  exit 0;',
    'done',
  ].join(' ');

  try {
    const output = await runRemote(script);
    return output.trim() || null;
  } catch {
    return null;
  }
};

/**
 * Reports whether the host app's bundled opencode-server can serve on the
 * remote machine: it needs a Node runtime of its own supported range with
 * glibc when on Linux, and the server files beside the binary's real path.
 */
export const probeBundledOpenCode = async (runRemote, shellQuote, binPath) => {
  if (!binPath) return false;
  const probeScript = [
    `PATH="${REMOTE_PATH_PREFIX}:$PATH"`,
    `node -e 'const fs=require("node:fs"),path=require("node:path");`,
    `if(process.versions.bun)process.exit(1);`,
    `const[maj,min]=(process.versions.node||"").split(".").map(Number);`,
    `if(!(maj>=24||(maj===22&&min>=16)))process.exit(1);`,
    `if(process.platform==="linux"&&!process.report?.getReport?.()?.header?.glibcVersionRuntime)process.exit(1);`,
    `const real=fs.realpathSync(process.argv[1]);`,
    `const dir=path.resolve(path.dirname(real),"..","opencode-server");`,
    `if(!fs.existsSync(path.join(dir,"serve.mjs"))||!fs.existsSync(path.join(dir,"assets","manifest.json")))process.exit(1);`,
    `process.stdout.write("bundled\\n");'`,
    shellQuote(binPath),
    '2>/dev/null || true',
  ].join(' ');
  try {
    const output = await runRemote(probeScript);
    return output.trim() === 'bundled';
  } catch {
    return false;
  }
};
