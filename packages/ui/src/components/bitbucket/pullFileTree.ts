// The changed-files list of a pull, grouped into the folders its paths
// carry. Nothing here reads a store or the DOM: paths go in, a row tree
// comes out, so the grouping — the part with the edge cases — is testable
// as data. The renderer walks the result and owns every pixel of it.

import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';

type PullFile = BitbucketPullView['files'][number];

/** A directory row: its own files and the folders below it. */
type PullFileFolder = {
    kind: 'folder';
    /** Full path of the folder, the key the collapse state holds. */
    path: string;
    /**
     * What the row shows: the folder's own name, or the names of a
     * single-child chain joined by '/' when this row stands for the whole
     * chain (see `compact`).
     */
    label: string;
    /** Files under this folder, however deep; the badge on the row. */
    fileCount: number;
    children: PullFileRow[];
};

/** One changed file, offered as the server listed it. */
type PullFileLeaf = {
    kind: 'file';
    file: PullFile;
};

export type PullFileRow = PullFileFolder | PullFileLeaf;

/** The builder's working node; `finish` turns these into rows. */
type TreeNode = {
    folders: Map<string, TreeNode>;
    files: PullFile[];
};

const emptyNode = (): TreeNode => ({ folders: new Map(), files: [] });

/** Path segments of a changed file, the last one being its own name. */
const segmentsOf = (path: string): string[] => path.split('/').filter((segment) => segment.length > 0);

/**
 * The changed files as a folder tree, in the order the server listed them:
 * folders first, then files, each level in that same order — the way the
 * app's own file tree reads. A folder whose subtree holds nothing but one
 * deeper folder is merged into its child (`a/b/c/x.ts` becomes one row
 * `a/b/c`), which is what keeps a Java or Kotlin pull's long package paths
 * from eating the column. The merged row keeps the outermost path as its
 * key, since collapsing it takes the whole chain with it.
 */
export const buildPullFileTree = (files: readonly PullFile[]): PullFileRow[] => {
    const root = emptyNode();
    for (const file of files) {
        const segments = segmentsOf(file.path);
        if (segments.length === 0) continue;
        let node = root;
        for (const segment of segments.slice(0, -1)) {
            const child = node.folders.get(segment) ?? emptyNode();
            node.folders.set(segment, child);
            node = child;
        }
        node.files.push(file);
    }
    return finish(root, '');
};

/** The rows of one node: its folders (compacted) first, then its files. */
const finish = (node: TreeNode, parentPath: string): PullFileRow[] => {
    const folders: PullFileRow[] = [];
    for (const [name, child] of node.folders) {
        folders.push(compact(name, child, parentPath ? `${parentPath}/${name}` : name));
    }
    return [...folders, ...node.files.map((file): PullFileRow => ({ kind: 'file', file }))];
};

/**
 * A folder with its single-child chains folded in. Merging stops at the
 * first level holding a file or branching, so `a` turns into `a/b/c` only
 * when every path under `a` runs through `c`.
 */
const compact = (name: string, node: TreeNode, path: string): PullFileFolder => {
    let label = name;
    let walked = path;
    let current = node;
    while (current.files.length === 0 && current.folders.size === 1) {
        const [childName, childNode] = [...current.folders][0]!;
        label = `${label}/${childName}`;
        walked = `${walked}/${childName}`;
        current = childNode;
    }
    return {
        kind: 'folder',
        path,
        label,
        fileCount: countFiles(current),
        children: finish(current, walked),
    };
};

const countFiles = (node: TreeNode): number => node.files.length
    + [...node.folders.values()].reduce((total, child) => total + countFiles(child), 0);
