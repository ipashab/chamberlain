const MISSING_UPDATE_FEED_RE =
  /404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/i;

const isMissingUpdateFeedError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MISSING_UPDATE_FEED_RE.test(message);
};

const NETWORK_ERROR_RE = /net::(ERR_[A-Z_]+)|\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/;

export const describeCheckFailure = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status = Number(error?.statusCode ?? /^(?:HttpError:\s*)?(\d{3})\b/.exec(message)?.[1]);
  if (Number.isInteger(status) && status >= 400) return `HTTP ${status}`;
  const network = NETWORK_ERROR_RE.exec(message);
  if (network) return network[1] ?? network[2];
  return message.split('\n')[0].trim().slice(0, 200) || 'unknown error';
};

const releaseNumbers = (version) => String(version ?? '').replace(/^v/, '').split('-')[0].split('.')
  .map((part) => Number.parseInt(part, 10) || 0);

const forkMarker = (version) => {
  const match = /^v?\d+(?:\.\d+){0,2}-fork(\d+)$/.exec(String(version ?? ''));
  return match ? Number.parseInt(match[1], 10) : null;
};

export const isDowngrade = (nextVersion, currentVersion) => {
  const next = releaseNumbers(nextVersion);
  const current = releaseNumbers(currentVersion);
  for (let index = 0; index < 3; index += 1) {
    if ((next[index] || 0) !== (current[index] || 0)) return (next[index] || 0) < (current[index] || 0);
  }
  // A fork release carries its whole upstream base plus the fork's work, so
  // the marker ranks it above the bare base: 2.7.3-fork1 sits past 2.7.3,
  // and only a higher base (or a higher fork marker) counts as newer.
  return (forkMarker(nextVersion) ?? 0) < (forkMarker(currentVersion) ?? 0);
};

export const checkForDesktopUpdate = async ({ autoUpdater, currentVersion, pendingUpdate, missingFeedIsError = false }) => {
  let updateResult;
  try {
    updateResult = await autoUpdater.checkForUpdates();
  } catch (error) {
    if (isMissingUpdateFeedError(error) && !pendingUpdate && !missingFeedIsError) {
      return {
        available: false,
        updateInfo: null,
        updateResult: null,
        nextVersion: currentVersion,
        pendingUpdate: null,
      };
    }
    throw new Error(`Unable to check for updates (${describeCheckFailure(error)})`, { cause: error });
  }

  const updateInfo = updateResult?.updateInfo;
  const available = updateResult?.isUpdateAvailable === true
    && typeof updateInfo?.version === 'string'
    && updateInfo.version.length > 0;
  const nextVersion = available ? updateInfo.version : currentVersion;
  const downgrade = available && isDowngrade(nextVersion, currentVersion);
  // A fork build never moves onto the bare upstream base it already
  // carries, so that offer is not an update at all. A canary keeps the
  // flagged downgrade it may choose to install.
  const offers = available && !(downgrade && forkMarker(currentVersion) !== null);
  const sameVersion = pendingUpdate?.version === nextVersion;
  return {
    available: offers,
    updateInfo,
    updateResult,
    nextVersion: offers ? nextVersion : currentVersion,
    pendingUpdate: offers
      ? {
          ...(sameVersion ? pendingUpdate : {}),
          version: nextVersion,
          electronUpdate: updateResult,
          downgrade,
        }
      : null,
  };
};

export const markDesktopUpdateDownloaded = (pendingUpdate, info) => {
  if (!pendingUpdate || pendingUpdate.version !== info?.version) return;
  pendingUpdate.downloaded = true;
  if (info.downloadedFile) pendingUpdate.downloadedFile = info.downloadedFile;
};

export const downloadPendingDesktopUpdate = async ({ autoUpdater, state }) => {
  const pendingUpdate = state.pendingUpdate;
  if (!pendingUpdate) throw new Error('No pending update');
  if (state.updateDownloadPromise) {
    if (state.updateDownloadVersion !== pendingUpdate.version) {
      throw new Error('Another update download is already in progress. Try again when it finishes.');
    }
    return state.updateDownloadPromise;
  }
  if (!pendingUpdate.electronUpdate) {
    throw new Error('Electron updater metadata is not available for this build');
  }
  if (pendingUpdate.downloaded) return;

  state.updateDownloadPromise = Promise.resolve(autoUpdater.downloadUpdate()).then((files) => {
    markDesktopUpdateDownloaded(state.pendingUpdate, {
      version: pendingUpdate.version,
      downloadedFile: files?.[0],
    });
  });
  state.updateDownloadVersion = pendingUpdate.version;
  try {
    await state.updateDownloadPromise;
  } finally {
    state.updateDownloadPromise = null;
    state.updateDownloadVersion = null;
  }
};
