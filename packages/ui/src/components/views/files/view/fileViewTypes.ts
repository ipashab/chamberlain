
export type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
};

export type SelectedLineRange = {
  start: number;
  end: number;
};

export interface FilesViewProps {
  visible?: boolean;
  mode?: 'full' | 'editor-only';
  /**
   * Закреплённый файл: вкладка файла в области контекстной панели закрепляет
   * свою панель за собственным путём, чтобы две области показывали два файла.
   * Без закреплённого пути открытый файл задаёт общее выделение корня.
   * Только для editor-only.
   */
  pinnedPath?: string | null;
  onCloseFile?: (path: string) => void;
}

export type TextViewMode = 'view' | 'edit';
export type PreviewViewMode = 'preview' | 'edit';
export type FilesViewOptions = Required<Pick<FilesViewProps, 'mode' | 'visible'>> & Pick<FilesViewProps, 'onCloseFile'>;
