import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { emitJson, isMain, ReleaseToolError, runCli, stableJson } from './shared.mjs';

export const CANONICAL_TREE_ALGORITHM = 'scriptspect-canonical-tree/v1';

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function treeDigest(entries) {
  const records = entries
    .map((entry) => `${entry.path}\0${entry.type}\0${entry.mode}\0${entry.sha256 ?? ''}\n`)
    .join('');
  return sha256(Buffer.from(records, 'utf8'));
}

const paxTarget = '../pax-target';
const symlinkTarget = '../bin/tool.mjs';
const paxVectorEntries = [
  { path: 'package', type: 'directory', mode: '0755', sha256: null },
  {
    path: 'package/pax-link',
    type: 'symlink',
    mode: '0777',
    sha256: sha256(Buffer.from(paxTarget, 'utf8')),
  },
];
const modeVectorEntries = [
  {
    path: 'mode.sh',
    type: 'file',
    mode: '4755',
    sha256: sha256(Buffer.from('mode\n', 'utf8')),
  },
];
const symlinkVectorEntries = [
  {
    path: 'tool-link',
    type: 'symlink',
    mode: '0777',
    sha256: sha256(Buffer.from(symlinkTarget, 'utf8')),
  },
];
const behaviorVectorContract = {
  schemaVersion: 'scriptspect-canonical-tree-behaviors/v1',
  vectors: [
    {
      name: 'pax-path-and-linkpath',
      input: {
        entries: [
          { type: 'pax', fields: { path: 'package/pax-link', linkpath: paxTarget } },
          {
            type: 'symlink',
            path: 'ignored-link',
            mode: '0777',
            linkTarget: 'ignored-target',
          },
        ],
      },
      expected: {
        entries: paxVectorEntries,
        treeDigest: treeDigest(paxVectorEntries),
      },
    },
    {
      name: 'duplicate-path',
      input: {
        entries: [
          { type: 'file', path: 'duplicate.txt', mode: '0644', content: 'one\n' },
          { type: 'file', path: 'duplicate.txt', mode: '0644', content: 'two\n' },
        ],
      },
      expected: { error: 'tar archive contains duplicate entry duplicate.txt' },
    },
    {
      name: 'mode-high-bits-mask',
      input: {
        entries: [{ type: 'file', path: 'mode.sh', mode: '104755', content: 'mode\n' }],
      },
      expected: {
        entries: modeVectorEntries,
        treeDigest: treeDigest(modeVectorEntries),
      },
    },
    {
      name: 'symlink-target-digest',
      input: {
        entries: [{ type: 'symlink', path: 'tool-link', mode: '0777', linkTarget: symlinkTarget }],
      },
      expected: {
        entries: symlinkVectorEntries,
        treeDigest: treeDigest(symlinkVectorEntries),
      },
    },
    {
      name: 'truncated-archive',
      input: {
        entries: [{ type: 'file', path: 'truncated.txt', mode: '0644', content: 'x' }],
        truncateBytes: 1,
      },
      expected: { error: 'tar archive length is not a multiple of 512 bytes' },
    },
  ],
};

export const CANONICAL_TREE_BEHAVIOR_VECTOR_DIGEST = sha256(
  Buffer.from(stableJson(behaviorVectorContract), 'utf8'),
);

const algorithmContract = {
  archive:
    'gzip tar with verified headers and safe paths; regular files, directories, and symlinks; implicit directories mode 0755',
  behaviorVectorDigest: CANONICAL_TREE_BEHAVIOR_VECTOR_DIGEST,
  contentDigest: 'sha256 raw file bytes; sha256 utf8 link target; null for directory',
  entryOrder: 'relative POSIX path ascending by UTF-8 code unit',
  entryRecord: 'path NUL type NUL mode-octal NUL content-digest-or-empty LF',
  mode: 'lstat mode & 0o7777 encoded as four lowercase octal digits',
  root: 'realpath directory; root entry excluded',
  version: CANONICAL_TREE_ALGORITHM,
};

export const CANONICAL_TREE_ALGORITHM_DIGEST = createHash('sha256')
  .update(stableJson(algorithmContract), 'utf8')
  .digest('hex');

function canonicalMode(mode) {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

function portablePath(rootPath, entryPath) {
  return relative(rootPath, entryPath).split(sep).join('/');
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'));
}

function buildManifest(inputEntries) {
  const entries = [...inputEntries].sort(comparePaths);
  const records = entries
    .map((entry) => `${entry.path}\0${entry.type}\0${entry.mode}\0${entry.sha256 ?? ''}\n`)
    .join('');
  return {
    algorithm: CANONICAL_TREE_ALGORITHM,
    algorithmDigest: CANONICAL_TREE_ALGORITHM_DIGEST,
    treeDigest: sha256(Buffer.from(records, 'utf8')),
    entries,
  };
}

async function visit(rootPath, directoryPath, entries) {
  const names = await readdir(directoryPath);
  names.sort();
  for (const name of names) {
    const entryPath = join(directoryPath, name);
    const stat = await lstat(entryPath);
    const path = portablePath(rootPath, entryPath);
    if (stat.isDirectory()) {
      entries.push({ path, type: 'directory', mode: canonicalMode(stat.mode), sha256: null });
      await visit(rootPath, entryPath, entries);
    } else if (stat.isFile()) {
      entries.push({
        path,
        type: 'file',
        mode: canonicalMode(stat.mode),
        sha256: sha256(await readFile(entryPath)),
      });
    } else if (stat.isSymbolicLink()) {
      entries.push({
        path,
        type: 'symlink',
        mode: canonicalMode(stat.mode),
        sha256: sha256(Buffer.from(await readlink(entryPath), 'utf8')),
      });
    } else {
      throw new ReleaseToolError(`canonical tree contains unsupported entry at ${path}`);
    }
  }
}

export async function canonicalizeTree(inputRoot) {
  verifyCanonicalTreeBehaviorVectors();
  let rootPath;
  try {
    rootPath = await realpath(inputRoot);
  } catch {
    throw new ReleaseToolError('canonical tree root could not be resolved');
  }
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory()) {
    throw new ReleaseToolError('canonical tree root must be a directory');
  }
  const entries = [];
  await visit(rootPath, rootPath, entries);
  return buildManifest(entries);
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function tarText(bytes, label) {
  const zero = bytes.indexOf(0);
  const content = zero === -1 ? bytes : bytes.subarray(0, zero);
  try {
    return utf8Decoder.decode(content);
  } catch {
    throw new ReleaseToolError(`${label} is not valid UTF-8`);
  }
}

function tarNumber(bytes, label) {
  if ((bytes[0] & 0x80) !== 0) {
    let value = BigInt(bytes[0] & 0x7f);
    for (const byte of bytes.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ReleaseToolError(`${label} exceeds the safe integer range`);
    }
    return Number(value);
  }
  const text = tarText(bytes, label).trim();
  if (!/^[0-7]*$/u.test(text)) throw new ReleaseToolError(`${label} is not octal`);
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function verifyTarChecksum(header) {
  const recorded = tarNumber(header.subarray(148, 156), 'tar header checksum');
  let calculated = 0;
  for (let index = 0; index < header.length; index += 1) {
    calculated += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (recorded !== calculated) throw new ReleaseToolError('tar header checksum mismatch');
}

function normalizeTarPath(input) {
  let path = input;
  while (path.startsWith('./')) path = path.slice(2);
  while (path.endsWith('/')) path = path.slice(0, -1);
  if (
    path === '' ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes('\\') ||
    path.includes('\0')
  ) {
    throw new ReleaseToolError('tar entry path is unsafe');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ReleaseToolError('tar entry path escapes the archive root');
  }
  return segments.join('/');
}

function parsePax(data) {
  const fields = Object.create(null);
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new ReleaseToolError('PAX record is missing its length separator');
    const lengthText = data.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/u.test(lengthText)) {
      throw new ReleaseToolError('PAX record length is invalid');
    }
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (end > data.length || data[end - 1] !== 0x0a) {
      throw new ReleaseToolError('PAX record length exceeds its data');
    }
    const record = tarText(data.subarray(space + 1, end - 1), 'PAX record');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new ReleaseToolError('PAX record is missing its key');
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return fields;
}

function addImplicitDirectories(entries, path) {
  const segments = path.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const directory = segments.slice(0, index).join('/');
    if (!entries.has(directory)) {
      entries.set(directory, {
        path: directory,
        type: 'directory',
        mode: '0755',
        sha256: null,
        implicit: true,
      });
    }
  }
}

function addTarEntry(entries, entry) {
  addImplicitDirectories(entries, entry.path);
  const existing = entries.get(entry.path);
  if (existing && !(existing.implicit && entry.type === 'directory')) {
    throw new ReleaseToolError(`tar archive contains duplicate entry ${entry.path}`);
  }
  entries.set(entry.path, entry);
}

function parseTarArchive(archive) {
  if (archive.length % 512 !== 0) {
    throw new ReleaseToolError('tar archive length is not a multiple of 512 bytes');
  }
  const entries = new Map();
  let offset = 0;
  let localPax = {};
  let globalPax = {};
  let longName;
  let longLink;
  let foundEndMarker = false;
  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      const secondEndBlock = archive.subarray(offset + 512, offset + 1024);
      if (
        secondEndBlock.length !== 512 ||
        !secondEndBlock.every((byte) => byte === 0) ||
        !archive.subarray(offset + 1024).every((byte) => byte === 0)
      ) {
        throw new ReleaseToolError('tar archive is missing its two-block end marker');
      }
      foundEndMarker = true;
      break;
    }
    verifyTarChecksum(header);
    const size = tarNumber(header.subarray(124, 136), 'tar entry size');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new ReleaseToolError('tar entry exceeds archive bounds');
    const data = archive.subarray(dataStart, dataEnd);
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const prefix = tarText(header.subarray(345, 500), 'tar entry prefix');
    const headerName = tarText(header.subarray(0, 100), 'tar entry name');
    const combinedName = prefix ? `${prefix}/${headerName}` : headerName;
    if (typeFlag === 'x') {
      localPax = parsePax(data);
    } else if (typeFlag === 'g') {
      globalPax = { ...globalPax, ...parsePax(data) };
    } else if (typeFlag === 'L') {
      longName = tarText(data, 'GNU long entry name').replace(/\n$/u, '');
    } else if (typeFlag === 'K') {
      longLink = tarText(data, 'GNU long link name').replace(/\n$/u, '');
    } else {
      const attributes = { ...globalPax, ...localPax };
      const entryPath = normalizeTarPath(attributes.path ?? longName ?? combinedName);
      const mode = canonicalMode(tarNumber(header.subarray(100, 108), 'tar entry mode'));
      if (typeFlag === '0' || typeFlag === '\0') {
        addTarEntry(entries, {
          path: entryPath,
          type: 'file',
          mode,
          sha256: sha256(data),
        });
      } else if (typeFlag === '5') {
        addTarEntry(entries, { path: entryPath, type: 'directory', mode, sha256: null });
      } else if (typeFlag === '2') {
        const target =
          attributes.linkpath ?? longLink ?? tarText(header.subarray(157, 257), 'tar link');
        addTarEntry(entries, {
          path: entryPath,
          type: 'symlink',
          mode,
          sha256: sha256(Buffer.from(target, 'utf8')),
        });
      } else {
        throw new ReleaseToolError(`tar archive contains unsupported type ${typeFlag}`);
      }
      localPax = {};
      longName = undefined;
      longLink = undefined;
    }
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    if (nextOffset > archive.length) throw new ReleaseToolError('tar entry exceeds archive bounds');
    offset = nextOffset;
  }
  if (!foundEndMarker)
    throw new ReleaseToolError('tar archive is missing its two-block end marker');
  const normalized = [...entries.values()].map(({ implicit: _implicit, ...entry }) => entry);
  return buildManifest(normalized);
}

function vectorTarField(value, width, label) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > width) {
    throw new ReleaseToolError(`canonical tree behavior vector ${label} exceeds ${width} bytes`);
  }
  const field = Buffer.alloc(width);
  bytes.copy(field);
  return field;
}

function vectorTarOctal(value, width, label) {
  return vectorTarField(`${value.toString(8).padStart(width - 1, '0')}\0`, width, label);
}

function vectorTarHeader({ name, typeFlag, mode, size, linkName = '' }) {
  const header = Buffer.alloc(512);
  vectorTarField(name, 100, 'entry name').copy(header, 0);
  vectorTarOctal(mode, 8, 'entry mode').copy(header, 100);
  vectorTarOctal(0, 8, 'owner ID').copy(header, 108);
  vectorTarOctal(0, 8, 'group ID').copy(header, 116);
  vectorTarOctal(size, 12, 'entry size').copy(header, 124);
  vectorTarOctal(0, 12, 'modification time').copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = typeFlag.charCodeAt(0);
  vectorTarField(linkName, 100, 'link name').copy(header, 157);
  vectorTarField('ustar\0', 6, 'magic').copy(header, 257);
  vectorTarField('00', 2, 'version').copy(header, 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  vectorTarField(`${checksum.toString(8).padStart(6, '0')}\0 `, 8, 'checksum').copy(header, 148);
  return header;
}

function vectorPaxData(fields) {
  return Object.entries(fields)
    .map(([key, value]) => {
      const body = `${key}=${value}\n`;
      let length = Buffer.byteLength(body, 'utf8') + 2;
      while (Buffer.byteLength(`${length} ${body}`, 'utf8') !== length) {
        length = Buffer.byteLength(`${length} ${body}`, 'utf8');
      }
      return `${length} ${body}`;
    })
    .join('');
}

function buildBehaviorVectorArchive(input) {
  const chunks = [];
  for (const entry of input.entries) {
    let name;
    let typeFlag;
    let mode;
    let linkName = '';
    let data;
    if (entry.type === 'pax') {
      name = 'PaxHeaders/vector';
      typeFlag = 'x';
      mode = 0;
      data = Buffer.from(vectorPaxData(entry.fields), 'utf8');
    } else {
      name = entry.path;
      typeFlag = entry.type === 'symlink' ? '2' : entry.type === 'directory' ? '5' : '0';
      mode = Number.parseInt(entry.mode, 8);
      linkName = entry.linkTarget ?? '';
      data = Buffer.from(entry.content ?? '', 'utf8');
    }
    chunks.push(vectorTarHeader({ name, typeFlag, mode, size: data.length, linkName }), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = Buffer.concat(chunks);
  return input.truncateBytes ? archive.subarray(0, archive.length - input.truncateBytes) : archive;
}

let verifiedBehaviorVectors;

export function verifyCanonicalTreeBehaviorVectors() {
  if (verifiedBehaviorVectors) {
    return {
      behaviorVectorDigest: CANONICAL_TREE_BEHAVIOR_VECTOR_DIGEST,
      verifiedVectors: [...verifiedBehaviorVectors],
    };
  }
  const verified = [];
  for (const vector of behaviorVectorContract.vectors) {
    let actual;
    let errorMessage;
    try {
      actual = parseTarArchive(buildBehaviorVectorArchive(vector.input));
    } catch (error) {
      errorMessage =
        error instanceof ReleaseToolError ? error.message : 'unexpected behavior vector failure';
    }
    if (Object.hasOwn(vector.expected, 'error')) {
      if (errorMessage !== vector.expected.error) {
        throw new ReleaseToolError(
          `canonical tree behavior vector ${vector.name} failed: expected ${vector.expected.error}, received ${errorMessage ?? 'success'}`,
        );
      }
    } else {
      if (errorMessage) {
        throw new ReleaseToolError(
          `canonical tree behavior vector ${vector.name} failed: ${errorMessage}`,
        );
      }
      const actualResult = { entries: actual.entries, treeDigest: actual.treeDigest };
      if (stableJson(actualResult) !== stableJson(vector.expected)) {
        throw new ReleaseToolError(
          `canonical tree behavior vector ${vector.name} failed: result mismatch`,
        );
      }
    }
    verified.push(vector.name);
  }
  verifiedBehaviorVectors = verified;
  return {
    behaviorVectorDigest: CANONICAL_TREE_BEHAVIOR_VECTOR_DIGEST,
    verifiedVectors: [...verified],
  };
}

export function canonicalizeTarball(path) {
  verifyCanonicalTreeBehaviorVectors();
  let compressed;
  try {
    compressed = readFileSync(path);
  } catch {
    throw new ReleaseToolError('tarball could not be read');
  }
  let archive;
  try {
    archive = gunzipSync(compressed);
  } catch {
    throw new ReleaseToolError('tarball is not a valid gzip stream');
  }
  return parseTarArchive(archive);
}

function difference(left, right) {
  if (!left) return 'added';
  if (!right) return 'removed';
  if (left.type !== right.type) return 'type';
  if (left.mode !== right.mode) return 'mode';
  if (left.sha256 !== right.sha256) return 'content';
  return undefined;
}

export async function compareCanonicalTrees(leftRoot, rightRoot) {
  const [left, right] = await Promise.all([
    canonicalizeTree(leftRoot),
    canonicalizeTree(rightRoot),
  ]);
  const leftEntries = new Map(left.entries.map((entry) => [entry.path, entry]));
  const rightEntries = new Map(right.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...leftEntries.keys(), ...rightEntries.keys()])].sort();
  const differences = [];
  for (const path of paths) {
    const kind = difference(leftEntries.get(path), rightEntries.get(path));
    if (kind) differences.push({ path, kind });
  }
  return {
    equal: differences.length === 0,
    algorithm: CANONICAL_TREE_ALGORITHM,
    algorithmDigest: CANONICAL_TREE_ALGORITHM_DIGEST,
    leftTreeDigest: left.treeDigest,
    rightTreeDigest: right.treeDigest,
    differences,
  };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === 'algorithm-digest') {
    verifyCanonicalTreeBehaviorVectors();
    emitJson({
      algorithm: CANONICAL_TREE_ALGORITHM,
      algorithmDigest: CANONICAL_TREE_ALGORITHM_DIGEST,
    });
    return;
  }
  if (arguments_.length === 3 && arguments_[0] === 'digest' && arguments_[1] === '--tarball') {
    emitJson(canonicalizeTarball(arguments_[2]));
    return;
  }
  if (arguments_.length === 3 && arguments_[0] === 'digest' && arguments_[1] === '--directory') {
    emitJson(await canonicalizeTree(arguments_[2]));
    return;
  }
  if (arguments_.length === 1) {
    emitJson(await canonicalizeTree(arguments_[0]));
    return;
  }
  if (arguments_.length === 3 && arguments_[0] === '--compare') {
    emitJson(await compareCanonicalTrees(arguments_[1], arguments_[2]));
    return;
  }
  throw new ReleaseToolError(
    'usage: canonical-tree.mjs algorithm-digest | digest --tarball <file> | digest --directory <dir> | <directory> | --compare <left> <right>',
  );
}

if (isMain(import.meta.url)) runCli(main);
