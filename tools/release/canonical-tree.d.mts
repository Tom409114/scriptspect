export type CanonicalTreeEntry = {
  path: string;
  type: 'directory' | 'file' | 'symlink';
  mode: string;
  sha256: string | null;
};

export type CanonicalTree = {
  algorithm: 'scriptspect-canonical-tree/v1';
  algorithmDigest: string;
  treeDigest: string;
  entries: CanonicalTreeEntry[];
};

export type CanonicalTreeDifference = {
  path: string;
  kind: 'added' | 'removed' | 'type' | 'mode' | 'content';
};

export type CanonicalTreeSourceBundle = {
  schemaVersion: 'scriptspect-canonical-tree-source-bundle/v1';
  entry: 'canonical-tree.mjs';
  files: Array<{ path: string; sourceSha256: string }>;
  digest: string;
};

export const CANONICAL_TREE_ALGORITHM: 'scriptspect-canonical-tree/v1';
export const CANONICAL_TREE_ALGORITHM_DIGEST: string;
export const CANONICAL_TREE_BEHAVIOR_VECTOR_DIGEST: string;
export const CANONICAL_TREE_SOURCE_BUNDLE: CanonicalTreeSourceBundle;
export function verifyCanonicalTreeBehaviorVectors(): {
  behaviorVectorDigest: string;
  verifiedVectors: string[];
};
export function canonicalizeTree(rootPath: string): Promise<CanonicalTree>;
export function canonicalizeTarball(path: string): CanonicalTree;
export function compareCanonicalTrees(
  leftRoot: string,
  rightRoot: string,
): Promise<{
  equal: boolean;
  algorithm: 'scriptspect-canonical-tree/v1';
  algorithmDigest: string;
  leftTreeDigest: string;
  rightTreeDigest: string;
  differences: CanonicalTreeDifference[];
}>;
