/** Git 变更条目：路径同时给出仓库相对路径（git 命令用）与工作区路径（打开文件用） */
export interface GitChangeEntry {
  /** 仓库根目录相对路径 */
  gitPath: string;
  /** 工作区路径：rootName/rel 或 rel */
  path: string;
  /** 重命名前的仓库相对路径 */
  origPath?: string;
  /** porcelain 的索引状态位 */
  index: string;
  /** porcelain 的工作区状态位 */
  worktree: string;
  staged: boolean;
  untracked: boolean;
  kind:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'untracked'
    | 'conflicted';
}

export interface GitStatusResult {
  available: boolean;
  repoRoot?: string;
  branch?: string;
  entries: GitChangeEntry[];
  message?: string;
}

export interface GitDiffResult {
  patch: string;
  message?: string;
}
