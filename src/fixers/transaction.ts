import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalizeRoot, RootBoundaryError, resolveContainedPath } from '../core/root';

export const TRANSACTION_OWNER = 'scriptspect';
export const TRANSACTION_FORMAT_VERSION = 1;

export type TransactionTerminalState =
  | 'success'
  | 'rollback-success'
  | 'rollback-partial'
  | 'manual-recovery-required';
export type TransactionState =
  | 'preparing'
  | 'prepared'
  | 'committing'
  | 'verifying'
  | 'rolling-back'
  | TransactionTerminalState;

type EntryState =
  | 'prepared'
  | 'committed'
  | 'rolled-back'
  | 'not-committed'
  | 'manual-recovery-required';

export interface RequestedWrite {
  path: string;
  content: string | Buffer;
  /** Digest captured when the replacement was calculated. */
  expectedSha256: string;
}

interface FileIdentity {
  canonicalPath: string;
  dev: string;
  ino: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  mode: number;
  sha256: string;
}

interface DirectoryIdentity {
  canonicalPath: string;
  dev: string;
  ino: string;
}

interface TransactionEntry {
  targetPath: string;
  backupPath: string;
  stagePath: string;
  holdPath: string;
  parent: DirectoryIdentity;
  original: FileIdentity;
  nextSha256: string;
  /** Exact identities of exclusively-created auxiliary files. */
  backup?: FileIdentity;
  stage?: FileIdentity;
  /** Original target inode moved aside during the no-clobber install. */
  hold?: FileIdentity;
  state: EntryState;
  committed?: FileIdentity;
  recoveryInstruction?: string;
}

interface TransactionJournal {
  owner: typeof TRANSACTION_OWNER;
  formatVersion: typeof TRANSACTION_FORMAT_VERSION;
  id: string;
  root: string;
  lockPath: string;
  lock: FileIdentity;
  state: TransactionState;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  manualAcknowledgedAt?: string;
  error?: string;
  entries: TransactionEntry[];
}

export interface TransactionOutcome {
  state: TransactionState;
  journalPath: string;
  backupPaths: string[];
}

export interface RecoveryOutcome extends TransactionOutcome {
  actions: string[];
}

export interface RecoveryOptions {
  apply?: boolean;
  acknowledgeManual?: boolean;
}

export class TransactionError extends Error {
  constructor(
    message: string,
    public readonly outcome: TransactionOutcome,
  ) {
    super(message);
    this.name = 'TransactionError';
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isContained(root: string, candidate: string, allowRoot = false): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return allowRoot;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonicalContainedDirectory(root: string, candidate: string): string {
  const canonicalRoot = canonicalizeRoot(root);
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch (error) {
    throw new RootBoundaryError(
      `cannot resolve directory inside the analysis root: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isContained(canonicalRoot, canonical, true)) {
    throw new RootBoundaryError('path is outside the analysis root');
  }
  return canonical;
}

function ensureOwnedDirectory(root: string, parent: string, name: string): string {
  const intended = join(parent, name);
  if (!existsSync(intended)) {
    mkdirSync(intended, { mode: 0o700 });
    fsyncDirectory(parent);
  }
  const identity = lstatSync(intended);
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new TransactionError(`transaction path is not a directory: ${intended}`, {
      state: 'rollback-partial',
      journalPath: intended,
      backupPaths: [],
    });
  }
  return canonicalContainedDirectory(root, intended);
}

function transactionDirectory(root: string, create: boolean): string | null {
  const canonicalRoot = canonicalizeRoot(root);
  const metadata = join(canonicalRoot, '.scriptspect');
  const transactions = join(metadata, 'transactions');
  if (!create && !existsSync(transactions)) return null;
  const canonicalMetadata = ensureOwnedDirectory(canonicalRoot, canonicalRoot, '.scriptspect');
  return ensureOwnedDirectory(canonicalRoot, canonicalMetadata, 'transactions');
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'EBADF'].includes(code ?? '')) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeExclusiveFile(path: string, bytes: Buffer, mode: number): void {
  const descriptor = openSync(path, 'wx', mode & 0o7777);
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, mode & 0o7777);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function persistJournal(journalPath: string, journal: TransactionJournal): void {
  journal.updatedAt = new Date().toISOString();
  const temporaryPath = `${journalPath}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, journalPath);
  fsyncDirectory(dirname(journalPath));
}

function snapshot(file: string, root: string): FileIdentity {
  const canonicalPath = resolveContainedPath(root, file);
  const before = statSync(canonicalPath, { bigint: true });
  if (!before.isFile())
    throw new TransactionError(`fix target is not a regular file: ${file}`, {
      state: 'rollback-partial',
      journalPath: '',
      backupPaths: [],
    });
  const bytes = readFileSync(canonicalPath);
  const after = statSync(canonicalPath, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error(`file changed while it was being read: ${file}`);
  }
  return {
    canonicalPath,
    dev: after.dev.toString(),
    ino: after.ino.toString(),
    nlink: after.nlink.toString(),
    size: after.size.toString(),
    mtimeNs: after.mtimeNs.toString(),
    mode: Number(after.mode),
    sha256: sha256(bytes),
  };
}

function snapshotDirectory(path: string, root: string): DirectoryIdentity {
  const canonicalPath = canonicalContainedDirectory(root, path);
  const identity = statSync(canonicalPath, { bigint: true });
  if (!identity.isDirectory()) throw new Error(`transaction parent is not a directory: ${path}`);
  return {
    canonicalPath,
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
  };
}

function sameDirectoryIdentity(actual: DirectoryIdentity, expected: DirectoryIdentity): boolean {
  return (
    actual.canonicalPath === expected.canonicalPath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
}

function validateParent(journal: TransactionJournal, entry: TransactionEntry): void {
  const actual = snapshotDirectory(dirname(entry.targetPath), journal.root);
  if (!sameDirectoryIdentity(actual, entry.parent)) {
    throw new Error(`transaction target parent identity changed: ${entry.parent.canonicalPath}`);
  }
}

function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return (
    actual.canonicalPath === expected.canonicalPath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.nlink === expected.nlink &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.mode === expected.mode &&
    actual.sha256 === expected.sha256
  );
}

function sameRenamedIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return sameIdentity({ ...actual, canonicalPath: expected.canonicalPath }, expected);
}

function sameInodeAndBytes(actual: FileIdentity, expected: FileIdentity): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.mode === expected.mode &&
    actual.sha256 === expected.sha256
  );
}

function requireSingleLink(identity: FileIdentity, label: string): void {
  if (identity.nlink !== '1') {
    throw new Error(`${label} has multiple hard links; refusing a topology-changing write`);
  }
}

function removeOwned(root: string, path: string, expected?: FileIdentity): void {
  if (!existsSync(path)) return;
  if (expected === undefined) {
    throw new Error(`refusing to remove unowned transaction file: ${path}`);
  }
  const actual = snapshot(path, root);
  if (!sameIdentity(actual, expected)) {
    throw new Error(`refusing to remove unowned transaction file: ${path}`);
  }
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function validateAuxiliaryPath(root: string, path: string): void {
  const canonicalRoot = canonicalizeRoot(root);
  const logical = resolve(path);
  if (!isContained(canonicalRoot, logical)) {
    throw new RootBoundaryError('path is outside the analysis root');
  }
}

function isFileIdentity(value: unknown): value is FileIdentity {
  if (value === null || typeof value !== 'object') return false;
  const identity = value as Partial<FileIdentity>;
  return (
    typeof identity.canonicalPath === 'string' &&
    typeof identity.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(identity.sha256) &&
    typeof identity.dev === 'string' &&
    /^\d+$/.test(identity.dev) &&
    typeof identity.ino === 'string' &&
    /^\d+$/.test(identity.ino) &&
    typeof identity.nlink === 'string' &&
    /^\d+$/.test(identity.nlink) &&
    typeof identity.size === 'string' &&
    /^\d+$/.test(identity.size) &&
    typeof identity.mtimeNs === 'string' &&
    /^\d+$/.test(identity.mtimeNs) &&
    typeof identity.mode === 'number'
  );
}

function isDirectoryIdentity(value: unknown): value is DirectoryIdentity {
  if (value === null || typeof value !== 'object') return false;
  const identity = value as Partial<DirectoryIdentity>;
  return (
    typeof identity.canonicalPath === 'string' &&
    typeof identity.dev === 'string' &&
    /^\d+$/.test(identity.dev) &&
    typeof identity.ino === 'string' &&
    /^\d+$/.test(identity.ino)
  );
}

function readJournal(journalPath: string): TransactionJournal {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(journalPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `cannot read transaction journal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value === null || typeof value !== 'object') throw new Error('invalid transaction journal');
  const candidate = value as Partial<TransactionJournal>;
  if (
    candidate.owner !== TRANSACTION_OWNER ||
    candidate.formatVersion !== TRANSACTION_FORMAT_VERSION ||
    typeof candidate.root !== 'string' ||
    typeof candidate.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id) ||
    typeof candidate.lockPath !== 'string' ||
    !isFileIdentity(candidate.lock) ||
    !Array.isArray(candidate.entries)
  ) {
    throw new Error('transaction journal ownership or version is invalid');
  }
  const root = canonicalizeRoot(candidate.root);
  const canonicalJournal = resolveContainedPath(root, journalPath);
  const ownedDirectory = canonicalContainedDirectory(
    root,
    join(root, '.scriptspect', 'transactions'),
  );
  if (canonicalJournal !== join(ownedDirectory, `${candidate.id}.json`)) {
    throw new RootBoundaryError('transaction journal is not in the owned transaction directory');
  }
  if (
    candidate.lockPath !== join(ownedDirectory, 'write.lock') ||
    candidate.lock.canonicalPath !== candidate.lockPath
  ) {
    throw new Error('transaction lock does not match its owned path');
  }
  const journalStates: readonly TransactionState[] = [
    'preparing',
    'prepared',
    'committing',
    'verifying',
    'rolling-back',
    'success',
    'rollback-success',
    'rollback-partial',
    'manual-recovery-required',
  ];
  const entryStates: readonly EntryState[] = [
    'prepared',
    'committed',
    'rolled-back',
    'not-committed',
    'manual-recovery-required',
  ];
  const targets = new Set<string>();
  const auxiliaryPaths = new Set<string>();
  if (!journalStates.includes(candidate.state as TransactionState)) {
    throw new Error('transaction journal contains an invalid state');
  }
  if (
    candidate.manualAcknowledgedAt !== undefined &&
    (typeof candidate.manualAcknowledgedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(candidate.manualAcknowledgedAt) ||
      candidate.archivedAt !== candidate.manualAcknowledgedAt ||
      candidate.state !== 'manual-recovery-required')
  ) {
    throw new Error('transaction journal contains an invalid manual acknowledgement');
  }
  for (let index = 0; index < candidate.entries.length; index += 1) {
    const entry = candidate.entries[index];
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.targetPath !== 'string' ||
      typeof entry.backupPath !== 'string' ||
      typeof entry.stagePath !== 'string' ||
      typeof entry.holdPath !== 'string' ||
      typeof entry.nextSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.nextSha256) ||
      !entryStates.includes(entry.state as EntryState) ||
      !isDirectoryIdentity(entry.parent) ||
      !isFileIdentity(entry.original) ||
      (entry.backup !== undefined && !isFileIdentity(entry.backup)) ||
      (entry.stage !== undefined && !isFileIdentity(entry.stage)) ||
      (entry.hold !== undefined && !isFileIdentity(entry.hold)) ||
      (entry.committed !== undefined && !isFileIdentity(entry.committed))
    ) {
      throw new Error('transaction journal contains an invalid entry');
    }
    validateAuxiliaryPath(root, entry.backupPath);
    validateAuxiliaryPath(root, entry.stagePath);
    validateAuxiliaryPath(root, entry.holdPath);
    if (!isContained(root, entry.original.canonicalPath)) {
      throw new RootBoundaryError('transaction target is outside the analysis root');
    }
    if (entry.targetPath !== entry.original.canonicalPath) {
      throw new Error('transaction target does not match its recorded identity');
    }
    requireSingleLink(entry.original, 'recorded original target');
    if (entry.parent.canonicalPath !== dirname(entry.targetPath)) {
      throw new Error('transaction parent does not match its target');
    }
    if (targets.has(entry.targetPath)) throw new Error('transaction journal has duplicate targets');
    targets.add(entry.targetPath);
    const expectedBackup = join(
      dirname(entry.targetPath),
      `.scriptspect-${candidate.id}-${index}.backup`,
    );
    const expectedStage = join(
      dirname(entry.targetPath),
      `.scriptspect-${candidate.id}-${index}.stage`,
    );
    const expectedHold = join(
      dirname(entry.targetPath),
      `.scriptspect-${candidate.id}-${index}.hold`,
    );
    if (
      entry.backupPath !== expectedBackup ||
      entry.stagePath !== expectedStage ||
      entry.holdPath !== expectedHold
    ) {
      throw new Error('transaction auxiliary path does not match its owned name');
    }
    for (const path of [entry.backupPath, entry.stagePath, entry.holdPath]) {
      if (auxiliaryPaths.has(path))
        throw new Error('transaction journal has duplicate auxiliaries');
      auxiliaryPaths.add(path);
    }
    if (entry.backup !== undefined && entry.backup.canonicalPath !== entry.backupPath) {
      throw new Error('transaction backup does not match its recorded identity');
    }
    if (entry.backup !== undefined) requireSingleLink(entry.backup, 'recorded backup');
    if (entry.stage !== undefined && entry.stage.canonicalPath !== entry.stagePath) {
      throw new Error('transaction stage does not match its recorded identity');
    }
    if (entry.stage !== undefined) requireSingleLink(entry.stage, 'recorded stage');
    if (entry.hold !== undefined && entry.hold.canonicalPath !== entry.holdPath) {
      throw new Error('transaction hold does not match its recorded identity');
    }
    const cleanedBeforeCommit =
      candidate.state === 'rollback-success' &&
      entry.state === 'not-committed' &&
      !existsSync(entry.backupPath) &&
      !existsSync(entry.stagePath);
    if (
      candidate.state !== 'preparing' &&
      candidate.state !== 'manual-recovery-required' &&
      candidate.state !== 'rollback-partial' &&
      !cleanedBeforeCommit &&
      (entry.backup === undefined || entry.stage === undefined)
    ) {
      throw new Error('prepared transaction is missing auxiliary identities');
    }
    if (
      entry.committed !== undefined &&
      (entry.committed.canonicalPath !== entry.targetPath ||
        entry.committed.sha256 !== entry.nextSha256 ||
        entry.stage === undefined ||
        !sameRenamedIdentity(entry.committed, entry.stage))
    ) {
      throw new Error('committed transaction entry has an invalid durable identity');
    }
    if (
      entry.hold !== undefined &&
      (!sameRenamedIdentity(entry.hold, entry.original) || entry.hold.nlink !== '1')
    ) {
      throw new Error('transaction hold has an invalid original identity');
    }
    if (
      (entry.state === 'committed' || entry.state === 'rolled-back') &&
      entry.committed === undefined
    ) {
      throw new Error('committed transaction entry is missing its durable identity');
    }
    if (
      (entry.state === 'prepared' || entry.state === 'not-committed') &&
      entry.committed !== undefined
    ) {
      throw new Error('non-committed transaction entry contains a committed identity');
    }
  }
  if (
    (candidate.state === 'prepared' &&
      candidate.entries.some((entry) => entry.state !== 'prepared')) ||
    (candidate.state === 'success' &&
      candidate.entries.some((entry) => entry.state !== 'committed')) ||
    (candidate.state === 'verifying' &&
      candidate.entries.some((entry) => entry.state !== 'committed')) ||
    (candidate.state === 'manual-recovery-required' &&
      candidate.entries.every((entry) => entry.state !== 'manual-recovery-required')) ||
    (candidate.state === 'rollback-success' &&
      candidate.entries.some(
        (entry) => entry.state !== 'rolled-back' && entry.state !== 'not-committed',
      ))
  ) {
    throw new Error('transaction journal state is inconsistent with its entries');
  }
  return candidate as TransactionJournal;
}

function outcome(journalPath: string, journal: TransactionJournal): TransactionOutcome {
  return {
    state: journal.state,
    journalPath,
    backupPaths: journal.entries.map((entry) => entry.backupPath),
  };
}

function transactionFailure(journalPath: string, journal: TransactionJournal): TransactionError {
  const details = [
    `write transaction ended in ${journal.state}`,
    `journal: ${journalPath}`,
    ...journal.entries.map((entry) => `backup: ${entry.backupPath}`),
  ];
  return new TransactionError(details.join('\n'), outcome(journalPath, journal));
}

function transactionFailureFromOutcome(failure: TransactionOutcome): TransactionError {
  return new TransactionError(
    [
      `write transaction ended in ${failure.state}`,
      `journal: ${failure.journalPath}`,
      ...failure.backupPaths.map((path) => `backup: ${path}`),
    ].join('\n'),
    failure,
  );
}

function validateBackup(journal: TransactionJournal, entry: TransactionEntry): Buffer {
  validateParent(journal, entry);
  if (entry.backup === undefined) {
    throw new Error(`backup identity is missing: ${entry.backupPath}`);
  }
  const canonical = resolveContainedPath(journal.root, entry.backupPath);
  const actual = snapshot(canonical, journal.root);
  if (!sameIdentity(actual, entry.backup)) {
    throw new Error(`backup identity mismatch: ${entry.backupPath}`);
  }
  requireSingleLink(actual, 'backup');
  const bytes = readFileSync(canonical);
  const after = snapshot(canonical, journal.root);
  if (!sameIdentity(after, entry.backup) || sha256(bytes) !== entry.original.sha256) {
    throw new Error(`backup digest mismatch: ${entry.backupPath}`);
  }
  return bytes;
}

function validateStage(journal: TransactionJournal, entry: TransactionEntry): FileIdentity {
  validateParent(journal, entry);
  if (entry.stage === undefined) {
    throw new Error(`stage identity is missing: ${entry.stagePath}`);
  }
  const canonical = resolveContainedPath(journal.root, entry.stagePath);
  const actual = snapshot(canonical, journal.root);
  if (!sameIdentity(actual, entry.stage)) {
    throw new Error(`stage identity mismatch: ${entry.stagePath}`);
  }
  requireSingleLink(actual, 'stage');
  if (actual.sha256 !== entry.nextSha256) {
    throw new Error(`staged file digest mismatch: ${entry.stagePath}`);
  }
  return actual;
}

function validateHold(journal: TransactionJournal, entry: TransactionEntry): FileIdentity {
  validateParent(journal, entry);
  if (entry.hold === undefined) throw new Error(`hold identity is missing: ${entry.holdPath}`);
  const actual = snapshot(entry.holdPath, journal.root);
  if (!sameIdentity(actual, entry.hold) || !sameRenamedIdentity(actual, entry.original)) {
    throw new Error(`original hold identity mismatch: ${entry.holdPath}`);
  }
  requireSingleLink(actual, 'original hold');
  return actual;
}

/**
 * Link an exclusively-owned inode into an absent target pathname. Unlike
 * rename-over-target, linkSync fails with EEXIST instead of overwriting a
 * concurrent writer. The source name is removed only after both links prove
 * that they still name the expected inode and no third hard link exists.
 */
function installExclusiveLink(
  journal: TransactionJournal,
  sourcePath: string,
  sourceIdentity: FileIdentity,
  targetPath: string,
): FileIdentity {
  const sourceBefore = snapshot(sourcePath, journal.root);
  if (!sameIdentity(sourceBefore, sourceIdentity)) {
    throw new Error(`install source identity changed: ${sourcePath}`);
  }
  requireSingleLink(sourceBefore, 'install source');
  linkSync(sourcePath, targetPath);
  fsyncDirectory(dirname(targetPath));

  const sourceLinked = snapshot(sourcePath, journal.root);
  const targetLinked = snapshot(targetPath, journal.root);
  if (
    !sameInodeAndBytes(sourceLinked, sourceIdentity) ||
    !sameInodeAndBytes(targetLinked, sourceIdentity) ||
    sourceLinked.dev !== targetLinked.dev ||
    sourceLinked.ino !== targetLinked.ino ||
    sourceLinked.nlink !== '2' ||
    targetLinked.nlink !== '2'
  ) {
    throw new Error(`exclusive install link verification failed: ${targetPath}`);
  }

  unlinkSync(sourcePath);
  fsyncDirectory(dirname(sourcePath));
  fsyncFile(targetPath);
  const installed = snapshot(targetPath, journal.root);
  if (!sameRenamedIdentity(installed, sourceIdentity) || installed.nlink !== '1') {
    throw new Error(`exclusive install verification failed: ${targetPath}`);
  }
  return installed;
}

/** Restore a just-moved file without ever replacing an occupied target. */
function restoreMovedFile(
  journal: TransactionJournal,
  movedPath: string,
  movedIdentity: FileIdentity,
  targetPath: string,
): FileIdentity {
  return installExclusiveLink(journal, movedPath, movedIdentity, targetPath);
}

function removeTerminalJournal(journalPath: string, journal: TransactionJournal): void {
  const identity = snapshot(journalPath, journal.root);
  requireSingleLink(identity, 'transaction journal');
  removeOwned(journal.root, journalPath, identity);
}

function cleanupTransactionFiles(journal: TransactionJournal): void {
  const errors: string[] = [];
  for (const entry of journal.entries) {
    for (const [path, identity] of [
      [entry.stagePath, entry.stage],
      [entry.backupPath, entry.backup],
      [entry.holdPath, entry.hold],
    ] as const) {
      try {
        removeOwned(journal.root, path, identity);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  try {
    removeOwned(journal.root, journal.lockPath, journal.lock);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
}

function reconcilePreparedEntries(journalPath: string, journal: TransactionJournal): void {
  for (const entry of journal.entries) {
    if (entry.state !== 'prepared') continue;
    try {
      if (existsSync(entry.holdPath)) {
        const actualHold = snapshot(entry.holdPath, journal.root);
        if (!sameRenamedIdentity(actualHold, entry.original)) {
          throw new Error(`original hold identity mismatch: ${entry.holdPath}`);
        }
        requireSingleLink(actualHold, 'original hold');
        if (entry.hold !== undefined && !sameIdentity(actualHold, entry.hold)) {
          throw new Error(`original hold changed: ${entry.holdPath}`);
        }
        entry.hold = actualHold;
      }

      let current: FileIdentity | undefined;
      try {
        current = snapshot(entry.targetPath, journal.root);
      } catch {
        current = undefined;
      }

      if (entry.hold !== undefined) {
        // A crash after moving the original but before installing the stage is
        // an ordinary rollback case, not a missing-target ambiguity.
        if (current === undefined) {
          persistJournal(journalPath, journal);
          continue;
        }
        if (entry.stage === undefined) throw new Error('stage identity is missing');
        if (existsSync(entry.stagePath)) {
          const linkedStage = snapshot(entry.stagePath, journal.root);
          if (
            !sameInodeAndBytes(linkedStage, entry.stage) ||
            !sameInodeAndBytes(current, entry.stage) ||
            linkedStage.dev !== current.dev ||
            linkedStage.ino !== current.ino ||
            linkedStage.nlink !== '2' ||
            current.nlink !== '2'
          ) {
            throw new Error('partially installed stage identity is ambiguous');
          }
          unlinkSync(entry.stagePath);
          fsyncDirectory(dirname(entry.stagePath));
          current = snapshot(entry.targetPath, journal.root);
        }
        if (!sameRenamedIdentity(current, entry.stage) || current.nlink !== '1') {
          throw new Error('installed target does not match the durable stage');
        }
        entry.state = 'committed';
        entry.committed = current;
        persistJournal(journalPath, journal);
        continue;
      }

      if (current !== undefined && sameIdentity(current, entry.original)) continue;
      throw new Error('target changed before the original hold was recorded');
    } catch (error) {
      markManual(
        journal,
        entry,
        `preserve target state for ${entry.targetPath}; restore manually from ${entry.backupPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      persistJournal(journalPath, journal);
    }
  }
}

function markManual(
  journal: TransactionJournal,
  entry: TransactionEntry,
  instruction: string,
): void {
  entry.state = 'manual-recovery-required';
  entry.recoveryInstruction = instruction;
  journal.state = 'manual-recovery-required';
}

function rollback(journalPath: string, journal: TransactionJournal): TransactionOutcome {
  journal.state = 'rolling-back';
  persistJournal(journalPath, journal);
  reconcilePreparedEntries(journalPath, journal);

  let partialFailure = false;
  for (const entry of [...journal.entries].reverse()) {
    if (entry.state === 'prepared') {
      try {
        validateBackup(journal, entry);
        if (entry.hold !== undefined) {
          const hold = validateHold(journal, entry);
          if (existsSync(entry.targetPath)) {
            markManual(
              journal,
              entry,
              `preserve changed target ${entry.targetPath}; original is retained at ${entry.holdPath}`,
            );
          } else {
            restoreMovedFile(journal, entry.holdPath, hold, entry.targetPath);
            entry.state = 'not-committed';
          }
        } else {
          const current = snapshot(entry.targetPath, journal.root);
          if (!sameIdentity(current, entry.original)) {
            markManual(
              journal,
              entry,
              `preserve changed target ${entry.targetPath}; restore manually from ${entry.backupPath}`,
            );
            persistJournal(journalPath, journal);
            continue;
          }
          if (existsSync(entry.stagePath)) validateStage(journal, entry);
          entry.state = 'not-committed';
        }
      } catch (error) {
        markManual(
          journal,
          entry,
          `preserve target state for ${entry.targetPath}; restore manually from ${entry.backupPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      persistJournal(journalPath, journal);
      continue;
    }
    if (entry.state !== 'committed') continue;

    let rollbackStage: string | undefined;
    let rollbackStageIdentity: FileIdentity | undefined;
    try {
      const original = validateBackup(journal, entry);
      rollbackStage = `${entry.stagePath}.${randomUUID()}.rollback`;
      writeExclusiveFile(rollbackStage, original, entry.original.mode);
      rollbackStageIdentity = snapshot(rollbackStage, journal.root);
      requireSingleLink(rollbackStageIdentity, 'rollback stage');
      if (rollbackStageIdentity.sha256 !== entry.original.sha256) {
        throw new Error(`rollback stage digest mismatch: ${rollbackStage}`);
      }
      const current = snapshot(entry.targetPath, journal.root);
      const stillOurs =
        current.sha256 === entry.nextSha256 &&
        entry.committed !== undefined &&
        sameIdentity(current, entry.committed);
      if (!stillOurs) {
        markManual(
          journal,
          entry,
          `preserve changed target ${entry.targetPath}; restore manually from ${entry.backupPath}`,
        );
        persistJournal(journalPath, journal);
        removeOwned(journal.root, rollbackStage, rollbackStageIdentity);
        rollbackStage = undefined;
        rollbackStageIdentity = undefined;
        continue;
      }
      if (existsSync(entry.stagePath)) {
        throw new Error(`refusing to overwrite an occupied consumed stage: ${entry.stagePath}`);
      }
      renameSync(entry.targetPath, entry.stagePath);
      fsyncDirectory(dirname(entry.targetPath));
      const detached = snapshot(entry.stagePath, journal.root);
      if (!sameRenamedIdentity(detached, current)) {
        try {
          restoreMovedFile(journal, entry.stagePath, detached, entry.targetPath);
        } catch {
          // Both names are retained for explicit manual recovery.
        }
        throw new Error(`target changed during rollback: ${entry.targetPath}`);
      }
      try {
        installExclusiveLink(journal, rollbackStage, rollbackStageIdentity, entry.targetPath);
        rollbackStage = undefined;
      } catch (error) {
        if (!existsSync(entry.targetPath) && existsSync(entry.stagePath)) {
          try {
            restoreMovedFile(journal, entry.stagePath, detached, entry.targetPath);
          } catch {
            // Preserve both controlled names for manual recovery.
          }
        }
        throw error;
      }
      removeOwned(journal.root, entry.stagePath, detached);
      entry.state = 'rolled-back';
      persistJournal(journalPath, journal);
    } catch (error) {
      if (rollbackStage !== undefined && rollbackStageIdentity !== undefined) {
        try {
          removeOwned(journal.root, rollbackStage, rollbackStageIdentity);
        } catch {
          // Preserve an unverified occupant; the manual instruction names the controlled backup.
        }
      }
      markManual(
        journal,
        entry,
        `restore ${entry.targetPath} manually from ${entry.backupPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      partialFailure = true;
      persistJournal(journalPath, journal);
    }
  }

  if (journal.entries.some((entry) => entry.state === 'manual-recovery-required')) {
    journal.state = 'manual-recovery-required';
  } else if (partialFailure) {
    journal.state = 'rollback-partial';
  } else {
    journal.state = 'rollback-success';
  }
  persistJournal(journalPath, journal);
  if (journal.state === 'rollback-success') {
    try {
      cleanupTransactionFiles(journal);
      removeTerminalJournal(journalPath, journal);
    } catch (error) {
      journal.error = `rollback succeeded but retained unverified transaction files: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (existsSync(journalPath)) {
        try {
          persistJournal(journalPath, journal);
        } catch {
          // The already-durable rollback-success state remains authoritative.
        }
      }
    }
  }
  return outcome(journalPath, journal);
}

export function findUnfinishedTransactions(root: string): string[] {
  const directory = transactionDirectory(root, false);
  if (directory === null) return [];
  const unfinished: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    try {
      const journal = readJournal(path);
      const terminal = journal.state === 'success' || journal.state === 'rollback-success';
      if (!terminal && journal.archivedAt === undefined) unfinished.push(path);
    } catch {
      unfinished.push(path);
    }
  }
  return unfinished;
}

export function prepareWriteTransaction(
  root: string,
  requests: readonly RequestedWrite[],
): TransactionOutcome {
  const canonicalRoot = canonicalizeRoot(root);
  if (requests.length === 0) {
    throw new Error('cannot create an empty write transaction');
  }

  const seen = new Set<string>();
  const preflight = requests.map((request) => {
    const original = snapshot(request.path, canonicalRoot);
    requireSingleLink(original, 'fix target');
    if (seen.has(original.canonicalPath)) {
      throw new Error(`duplicate write target: ${original.canonicalPath}`);
    }
    seen.add(original.canonicalPath);
    if (original.sha256 !== request.expectedSha256) {
      throw new Error(`file changed since the fix was planned: ${original.canonicalPath}`);
    }
    return {
      original,
      parent: snapshotDirectory(dirname(original.canonicalPath), canonicalRoot),
      content: Buffer.from(request.content),
      nextSha256: sha256(request.content),
    };
  });

  const directory = transactionDirectory(canonicalRoot, true) as string;
  const id = randomUUID();
  const lockPath = join(directory, 'write.lock');
  try {
    writeExclusiveFile(lockPath, Buffer.from(`${id}\n`), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const [blockedJournal] = findUnfinishedTransactions(canonicalRoot);
      const blockedPath = blockedJournal ?? lockPath;
      throw new TransactionError(
        `another write transaction already owns the project lock; recover it first: ${blockedPath}`,
        {
          state: 'manual-recovery-required',
          journalPath: blockedPath,
          backupPaths: [],
        },
      );
    }
    throw error;
  }
  const lock = snapshot(lockPath, canonicalRoot);
  const unfinished = findUnfinishedTransactions(canonicalRoot);
  if (unfinished.length > 0) {
    removeOwned(canonicalRoot, lockPath, lock);
    throw new TransactionError(
      `unfinished write transaction blocks --fix; recover it first: ${unfinished[0]}`,
      { state: 'manual-recovery-required', journalPath: unfinished[0] as string, backupPaths: [] },
    );
  }
  const journalPath = join(directory, `${id}.json`);
  const now = new Date().toISOString();
  const journal: TransactionJournal = {
    owner: TRANSACTION_OWNER,
    formatVersion: TRANSACTION_FORMAT_VERSION,
    id,
    root: canonicalRoot,
    lockPath,
    lock,
    state: 'preparing',
    createdAt: now,
    updatedAt: now,
    entries: preflight.map(({ original, parent, nextSha256 }, index) => ({
      targetPath: original.canonicalPath,
      backupPath: join(dirname(original.canonicalPath), `.scriptspect-${id}-${index}.backup`),
      stagePath: join(dirname(original.canonicalPath), `.scriptspect-${id}-${index}.stage`),
      holdPath: join(dirname(original.canonicalPath), `.scriptspect-${id}-${index}.hold`),
      parent,
      original,
      nextSha256,
      state: 'prepared',
    })),
  };

  try {
    persistJournal(journalPath, journal);
  } catch (error) {
    removeOwned(canonicalRoot, lockPath, lock);
    throw error;
  }
  try {
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index] as TransactionEntry;
      const item = preflight[index] as (typeof preflight)[number];
      validateParent(journal, entry);
      writeExclusiveFile(entry.backupPath, readFileSync(entry.targetPath), entry.original.mode);
      entry.backup = snapshot(entry.backupPath, canonicalRoot);
      if (entry.backup.nlink !== '1' || entry.backup.sha256 !== entry.original.sha256) {
        throw new Error(`backup verification failed: ${entry.backupPath}`);
      }
      writeExclusiveFile(entry.stagePath, item.content, entry.original.mode);
      entry.stage = snapshot(entry.stagePath, canonicalRoot);
      if (entry.stage.nlink !== '1' || entry.stage.sha256 !== entry.nextSha256) {
        throw new Error(`stage verification failed: ${entry.stagePath}`);
      }
      persistJournal(journalPath, journal);
    }
    journal.state = 'prepared';
    persistJournal(journalPath, journal);
    return outcome(journalPath, journal);
  } catch (error) {
    journal.error = error instanceof Error ? error.message : String(error);
    try {
      cleanupTransactionFiles(journal);
      journal.state = 'rollback-success';
    } catch (cleanupError) {
      journal.state = 'manual-recovery-required';
      journal.error += `; cleanup retained unverified files: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`;
    }
    for (const entry of journal.entries) {
      if (entry.state !== 'prepared') continue;
      if (journal.state === 'rollback-success') entry.state = 'not-committed';
      else {
        markManual(
          journal,
          entry,
          `inspect partially prepared backup ${entry.backupPath} and stage ${entry.stagePath}; an auxiliary identity is missing`,
        );
      }
    }
    persistJournal(journalPath, journal);
    const failure = outcome(journalPath, journal);
    if (journal.state === 'rollback-success') {
      try {
        removeTerminalJournal(journalPath, journal);
      } catch {
        // A verified terminal journal is safe to retain if exact removal fails.
      }
    }
    throw transactionFailureFromOutcome(failure);
  }
}

export function commitNextWrite(journalPath: string): TransactionOutcome {
  const journal = readJournal(journalPath);
  if (journal.state === 'prepared') {
    journal.state = 'committing';
    persistJournal(journalPath, journal);
  }
  if (journal.state !== 'committing') return outcome(journalPath, journal);
  const entry = journal.entries.find((candidate) => candidate.state === 'prepared');
  if (entry === undefined) return outcome(journalPath, journal);

  const stage = validateStage(journal, entry);
  const current = snapshot(entry.targetPath, journal.root);
  if (!sameIdentity(current, entry.original)) {
    throw new Error(`source identity changed immediately before commit: ${entry.targetPath}`);
  }
  if (existsSync(entry.holdPath)) {
    throw new Error(`refusing to overwrite an occupied transaction hold: ${entry.holdPath}`);
  }

  // Moving the target first means a concurrent replacement is preserved at the
  // hold name and can be restored through an EEXIST-safe hard link. We never
  // rename the stage over an occupied target pathname.
  renameSync(entry.targetPath, entry.holdPath);
  fsyncDirectory(dirname(entry.targetPath));
  const hold = snapshot(entry.holdPath, journal.root);
  if (!sameRenamedIdentity(hold, entry.original)) {
    try {
      restoreMovedFile(journal, entry.holdPath, hold, entry.targetPath);
    } catch (restoreError) {
      throw new Error(
        `source changed during commit and could not be restored automatically: ${entry.targetPath}: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`,
      );
    }
    throw new Error(`source identity changed during commit: ${entry.targetPath}`);
  }
  requireSingleLink(hold, 'original hold');
  entry.hold = hold;
  persistJournal(journalPath, journal);

  const immediatelyBeforeInstall = validateStage(journal, entry);
  if (!sameIdentity(immediatelyBeforeInstall, stage)) {
    throw new Error(`stage identity changed immediately before commit: ${entry.stagePath}`);
  }
  const committed = installExclusiveLink(
    journal,
    entry.stagePath,
    immediatelyBeforeInstall,
    entry.targetPath,
  );
  entry.state = 'committed';
  entry.committed = committed;
  persistJournal(journalPath, journal);
  return outcome(journalPath, journal);
}

function fsyncFile(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r+');
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EBADF'].includes(code ?? '')) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function installWriteTransaction(journalPath: string): TransactionOutcome {
  let journal = readJournal(journalPath);
  try {
    while (journal.entries.some((entry) => entry.state === 'prepared')) {
      commitNextWrite(journalPath);
      journal = readJournal(journalPath);
    }
    if (journal.state !== 'committing') return outcome(journalPath, journal);
  } catch (error) {
    journal = readJournal(journalPath);
    journal.error = error instanceof Error ? error.message : String(error);
    persistJournal(journalPath, journal);
    const rolledBack = rollback(journalPath, journal);
    throw transactionFailureFromOutcome(rolledBack);
  }
  journal.state = 'verifying';
  try {
    persistJournal(journalPath, journal);
  } catch (error) {
    journal.state = 'committing';
    journal.error = `all targets were replaced but the verification state was not durable: ${
      error instanceof Error ? error.message : String(error)
    }`;
    throw transactionFailure(journalPath, journal);
  }
  return outcome(journalPath, journal);
}

export function finalizeWriteTransaction(journalPath: string): TransactionOutcome {
  const journal = readJournal(journalPath);
  if (journal.state === 'success') return outcome(journalPath, journal);
  if (journal.state !== 'verifying') {
    throw new Error(`cannot finalize transaction in state ${journal.state}`);
  }
  journal.state = 'success';
  persistJournal(journalPath, journal);
  try {
    cleanupTransactionFiles(journal);
    removeTerminalJournal(journalPath, journal);
  } catch (error) {
    journal.error = `successful write left transaction files for later cleanup: ${
      error instanceof Error ? error.message : String(error)
    }`;
    if (existsSync(journalPath)) {
      try {
        persistJournal(journalPath, journal);
      } catch {
        // The already-durable success state remains authoritative.
      }
    }
  }
  return outcome(journalPath, journal);
}

export function rollbackWriteTransaction(journalPath: string): TransactionOutcome {
  const journal = readJournal(journalPath);
  if (journal.state === 'success' || journal.state === 'rollback-success') {
    return outcome(journalPath, journal);
  }
  return rollback(journalPath, journal);
}

export function commitWriteTransaction(journalPath: string): TransactionOutcome {
  installWriteTransaction(journalPath);
  return finalizeWriteTransaction(journalPath);
}

export function executeWriteTransaction(
  root: string,
  requests: readonly RequestedWrite[],
): TransactionOutcome {
  const prepared = prepareWriteTransaction(root, requests);
  return commitWriteTransaction(prepared.journalPath);
}

function assessRecovery(journal: TransactionJournal): {
  actions: string[];
  manualEntries: Map<TransactionEntry, string>;
} {
  const actions: string[] = [];
  const manualEntries = new Map<TransactionEntry, string>();
  for (const entry of journal.entries) {
    if (entry.state === 'rolled-back' || entry.state === 'not-committed') continue;
    try {
      validateBackup(journal, entry);
    } catch (error) {
      const instruction = `preserve ${entry.targetPath}; backup requires manual inspection at ${entry.backupPath}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      manualEntries.set(entry, instruction);
      actions.push(instruction);
      continue;
    }
    if (entry.state === 'prepared' && existsSync(entry.holdPath)) {
      try {
        const hold = snapshot(entry.holdPath, journal.root);
        if (!sameRenamedIdentity(hold, entry.original) || hold.nlink !== '1') {
          throw new Error('original hold identity mismatch');
        }
        if (existsSync(entry.targetPath)) {
          if (entry.stage === undefined) throw new Error('stage identity is missing');
          const current = snapshot(entry.targetPath, journal.root);
          if (existsSync(entry.stagePath)) {
            const linkedStage = snapshot(entry.stagePath, journal.root);
            if (
              !sameInodeAndBytes(linkedStage, entry.stage) ||
              !sameInodeAndBytes(current, entry.stage) ||
              linkedStage.dev !== current.dev ||
              linkedStage.ino !== current.ino ||
              linkedStage.nlink !== '2' ||
              current.nlink !== '2'
            ) {
              throw new Error('partially installed stage identity is ambiguous');
            }
          } else if (!sameRenamedIdentity(current, entry.stage) || current.nlink !== '1') {
            throw new Error('installed target does not match the durable stage');
          }
        }
        actions.push(`restore ${entry.targetPath} from original hold ${entry.holdPath}`);
        continue;
      } catch (error) {
        const instruction = `restore ${entry.targetPath} manually from ${entry.backupPath}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        manualEntries.set(entry, instruction);
        actions.push(instruction);
        continue;
      }
    }
    let current: FileIdentity;
    try {
      current = snapshot(entry.targetPath, journal.root);
    } catch (error) {
      const instruction = `restore ${entry.targetPath} manually from ${entry.backupPath}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      manualEntries.set(entry, instruction);
      actions.push(instruction);
      continue;
    }
    if (entry.state === 'committed') {
      if (
        current.sha256 === entry.nextSha256 &&
        (entry.committed === undefined || sameIdentity(current, entry.committed))
      ) {
        actions.push(`restore ${entry.targetPath} from ${entry.backupPath}`);
      } else {
        const instruction = `preserve changed target ${entry.targetPath}; restore manually from ${entry.backupPath}`;
        manualEntries.set(entry, instruction);
        actions.push(instruction);
      }
      continue;
    }
    if (entry.state === 'prepared') {
      if (existsSync(entry.stagePath)) {
        try {
          validateStage(journal, entry);
        } catch (error) {
          const instruction = `preserve unverified stage ${entry.stagePath}; restore ${entry.targetPath} manually from ${entry.backupPath}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          manualEntries.set(entry, instruction);
          actions.push(instruction);
          continue;
        }
      }
      if (sameIdentity(current, entry.original))
        actions.push(`leave ${entry.targetPath} unchanged`);
      else if (
        entry.stage !== undefined &&
        current.sha256 === entry.nextSha256 &&
        !existsSync(entry.stagePath) &&
        sameRenamedIdentity(current, entry.stage)
      ) {
        actions.push(`restore ${entry.targetPath} from ${entry.backupPath}`);
      } else {
        const instruction = `preserve changed target ${entry.targetPath}; restore manually from ${entry.backupPath}`;
        manualEntries.set(entry, instruction);
        actions.push(instruction);
      }
      continue;
    }
    if (entry.recoveryInstruction !== undefined) actions.push(entry.recoveryInstruction);
  }
  return { actions, manualEntries };
}

function inspectOwnedRecoveryArtifact(path: string): {
  root: string;
  path: string;
  identity: FileIdentity;
} {
  const resolvedPath = resolve(path);
  const logicalIdentity = lstatSync(resolvedPath);
  if (!logicalIdentity.isFile() || logicalIdentity.isSymbolicLink()) {
    throw new Error('transaction recovery artifact is not a regular file');
  }
  const canonicalPath = realpathSync(resolvedPath);
  const directory = dirname(canonicalPath);
  const metadata = dirname(directory);
  const root = dirname(metadata);
  if (
    basename(directory) !== 'transactions' ||
    basename(metadata) !== '.scriptspect' ||
    canonicalizeRoot(root) !== root ||
    directory !== join(root, '.scriptspect', 'transactions')
  ) {
    throw new RootBoundaryError(
      'transaction recovery artifact is not in the owned transaction directory',
    );
  }
  const identity = snapshot(canonicalPath, root);
  requireSingleLink(identity, 'transaction recovery artifact');
  return { root, path: canonicalPath, identity };
}

function recoverUnreadableArtifact(
  journalPath: string,
  reason: unknown,
  options: RecoveryOptions,
): RecoveryOutcome {
  const artifact = inspectOwnedRecoveryArtifact(journalPath);
  const artifacts = [artifact];
  const relatedLock = join(dirname(artifact.path), 'write.lock');
  if (artifact.path !== relatedLock && existsSync(relatedLock)) {
    artifacts.unshift(inspectOwnedRecoveryArtifact(relatedLock));
  }
  const explanation = reason instanceof Error ? reason.message : String(reason);
  const actions = artifacts.map(
    (item) =>
      `inspect unreadable or orphan transaction artifact ${item.path} (sha256 ${item.identity.sha256}); explicit acknowledgement is required: ${explanation}`,
  );
  const base: RecoveryOutcome = {
    state: 'manual-recovery-required',
    journalPath: artifact.path,
    backupPaths: [],
    actions,
  };
  if (!options.apply || !options.acknowledgeManual) return base;

  // The maintainer explicitly acknowledged these exact identities. Unknown
  // backup/stage/hold paths are intentionally not inferred or deleted.
  for (const item of artifacts) removeOwned(item.root, item.path, item.identity);
  return { ...base, state: 'rollback-success' };
}

export function recoverTransaction(
  journalPath: string,
  options: RecoveryOptions = {},
): RecoveryOutcome {
  const resolvedJournal = resolve(journalPath);
  let journal: TransactionJournal;
  try {
    journal = readJournal(resolvedJournal);
  } catch (error) {
    return recoverUnreadableArtifact(resolvedJournal, error, options);
  }
  if (journal.state === 'success' || journal.state === 'rollback-success') {
    return { ...outcome(resolvedJournal, journal), actions: [] };
  }
  const assessed = assessRecovery(journal);
  if (!options.apply) {
    return {
      ...outcome(resolvedJournal, journal),
      state: assessed.manualEntries.size > 0 ? 'manual-recovery-required' : journal.state,
      actions: assessed.actions,
    };
  }

  if (options.acknowledgeManual) {
    if (
      journal.state !== 'manual-recovery-required' &&
      journal.state !== 'rollback-partial' &&
      assessed.manualEntries.size === 0
    ) {
      throw new Error('manual acknowledgement is valid only for a manual recovery journal');
    }
    for (const [entry, instruction] of assessed.manualEntries) {
      markManual(journal, entry, instruction);
    }
    persistJournal(resolvedJournal, journal);
    const rolledBack = rollback(resolvedJournal, journal);
    if (!existsSync(resolvedJournal)) {
      return { ...rolledBack, actions: assessed.actions };
    }
    journal = readJournal(resolvedJournal);
    if (
      journal.entries.some((entry) => entry.state === 'prepared' || entry.state === 'committed')
    ) {
      throw new Error('cannot acknowledge manual recovery while automatic rollback remains');
    }
    const acknowledgedAt = new Date().toISOString();
    journal.manualAcknowledgedAt = acknowledgedAt;
    journal.archivedAt = acknowledgedAt;
    removeOwned(journal.root, journal.lockPath, journal.lock);
    persistJournal(resolvedJournal, journal);
    return { ...outcome(resolvedJournal, journal), actions: assessed.actions };
  }

  if (assessed.manualEntries.size > 0) {
    for (const [entry, instruction] of assessed.manualEntries)
      markManual(journal, entry, instruction);
    persistJournal(resolvedJournal, journal);
    const rolledBack = rollback(resolvedJournal, journal);
    if (!existsSync(resolvedJournal)) {
      return { ...rolledBack, actions: assessed.actions };
    }
    journal = readJournal(resolvedJournal);
    return { ...outcome(resolvedJournal, journal), actions: assessed.actions };
  }
  reconcilePreparedEntries(resolvedJournal, journal);
  const rolledBack = rollback(resolvedJournal, journal);
  if (!existsSync(resolvedJournal)) return { ...rolledBack, actions: assessed.actions };
  journal = readJournal(resolvedJournal);
  return { ...outcome(resolvedJournal, journal), actions: assessed.actions };
}
