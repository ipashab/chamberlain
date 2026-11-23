import React from 'react';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { type FileNode } from './fileViewTypes';
import { normalizePath, toComparablePath, isPathWithinRoot } from './fileViewPaths';
import { type useFileScope } from './useFileScope';

export function useFileTabs({ scope, pinnedPath }: {
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
  pinnedPath?: string | null;
}) {
  const { root } = scope;
  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const openPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.openPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const expandedPathSet = React.useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const removeOpenPath = useFilesViewTabsStore((state) => state.removeOpenPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);
  const removeUnselectedOpenPath = useFilesViewTabsStore((state) => state.removeUnselectedOpenPath);
  const removeExpandedPathsByPrefix = useFilesViewTabsStore((state) => state.removeExpandedPathsByPrefix);
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);
  const expandPaths = useFilesViewTabsStore((state) => state.expandPaths);

  const toFileNode = React.useCallback((path: string): FileNode => {
    const normalized = normalizePath(path);
    const parts = normalized.split('/');
    const name = parts[parts.length - 1] || normalized;
    const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
    return {
      name,
      path: normalized,
      type: 'file',
      extension,
    };
  }, []);

  const openFiles = React.useMemo(() => openPaths.map(toFileNode), [openPaths, toFileNode]);
  const effectiveSelectedPath = React.useMemo(() => {
    // Закреплённая панель показывает свой закреплённый файл, что бы ни
    // держало общее выделение: так две области показывают два файла, а общее
    // выделение остаётся делом сайдбара. Предпочитаем канонический путь
    // открытой вкладки, чтобы кэши позиций и чтение файла сходились.
    if (pinnedPath) {
      const comparablePinned = toComparablePath(pinnedPath);
      return openPaths.find((path) => toComparablePath(path) === comparablePinned) ?? pinnedPath;
    }
    if (selectedPath) {
      const comparableSelected = toComparablePath(selectedPath);
      if (openPaths.some((path) => toComparablePath(path) === comparableSelected)) {
        return selectedPath;
      }
    }
    return openPaths[0] ?? null;
  }, [openPaths, pinnedPath, selectedPath]);
  const selectedFile = React.useMemo(() => (effectiveSelectedPath ? toFileNode(effectiveSelectedPath) : null), [effectiveSelectedPath, toFileNode]);
  const selectedFilePath = selectedFile?.path ?? '';
  const selectedFilePathRef = React.useRef(selectedFilePath);
  selectedFilePathRef.current = selectedFilePath;

  React.useEffect(() => {
    // Закреплённая панель не читает общее выделение, значит и не лечит его:
    // лечение перетягивало бы выделение к файлу закреплённой панели и спорило
    // с раскрытием файлов в других областях.
    if (pinnedPath) return;
    if (!root || !selectedPath) return;
    const comparableSelected = toComparablePath(selectedPath);
    const selectedIsOpen = openPaths.some((path) => toComparablePath(path) === comparableSelected);
    if (!selectedIsOpen) {
      setSelectedPath(root, openPaths[0] ?? null);
    }
  }, [openPaths, pinnedPath, root, selectedPath, setSelectedPath]);

  const selectedFileIsOutsideWorkspace = Boolean(root && selectedFilePath && !isPathWithinRoot(selectedFilePath, root));
  const selectedFileReadOptions = React.useMemo(
    () => ({
      allowOutsideWorkspace: selectedFileIsOutsideWorkspace,
      directory: root || undefined,
    }),
    [selectedFileIsOutsideWorkspace, root],
  );
  const resolveFileReadOptions = React.useCallback((path: string) => ({
    allowOutsideWorkspace: Boolean(root && !isPathWithinRoot(path, root)),
  }), [root]);
  return { openPaths, expandedPaths, expandedPathSet, removeOpenPath, removeOpenPathsByPrefix, removeUnselectedOpenPath, removeExpandedPathsByPrefix, setSelectedPath, toggleExpandedPath, expandPaths, toFileNode, openFiles, selectedFile, selectedFilePath, selectedFilePathRef, selectedFileIsOutsideWorkspace, selectedFileReadOptions, resolveFileReadOptions };
}
