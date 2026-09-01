import { readFileSync } from 'node:fs';

function fail(message) {
  throw new Error(`npm bootstrap state: ${message}`);
}

function parseArguments(args) {
  const expected = new Set(['--owners', '--owner', '--before', '--after', '--version']);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!expected.has(name)) fail(`unknown option ${name ?? ''}`);
    if (value === undefined || value.trim() === '') fail(`${name} needs a value`);
    if (values.has(name)) fail(`duplicate option ${name}`);
    values.set(name, value);
  }
  for (const name of ['--owners', '--owner']) {
    if (!values.has(name)) fail(`missing option ${name}`);
  }
  const stateOptions = ['--before', '--after', '--version'];
  const stateOptionCount = stateOptions.filter((name) => values.has(name)).length;
  if (stateOptionCount !== 0 && stateOptionCount !== stateOptions.length) {
    fail('before, after, and version must be supplied together');
  }
  return Object.fromEntries([...values].map(([name, value]) => [name.slice(2), value]));
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeNpmView(value, type, label) {
  const normalized = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (type === 'string') {
    if (typeof normalized !== 'string' || normalized.trim() === '') {
      fail(`${label} must contain one non-empty string result`);
    }
    return normalized;
  }
  if (
    type === 'object' &&
    (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized))
  ) {
    fail(`${label} must contain one object result`);
  }
  return normalized;
}

function parseNormalizeArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--input', '--type'].includes(name)) fail(`unknown normalize option ${name ?? ''}`);
    if (value === undefined || value.trim() === '') fail(`${name} needs a value`);
    if (values.has(name)) fail(`duplicate normalize option ${name}`);
    values.set(name, value);
  }
  if (!values.has('--input') || !values.has('--type')) {
    fail('normalize requires input and type');
  }
  const type = values.get('--type');
  if (type !== 'string' && type !== 'object') fail('normalize type must be string or object');
  return { input: values.get('--input'), type };
}

function maintainerName(value) {
  if (typeof value === 'string') {
    const match = /^([^\s<]+)(?:\s|<|$)/u.exec(value.trim());
    if (match?.[1] !== undefined) return match[1];
  } else if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.name === 'string' &&
    value.name.trim() !== ''
  ) {
    return value.name.trim();
  }
  fail('maintainers contain an unsupported entry');
}

function maintainerNames(value) {
  const normalized =
    Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) ? value[0] : value;
  const entries = Array.isArray(normalized) ? normalized : [normalized];
  if (entries.length === 0) fail('maintainers are empty');
  return [...new Set(entries.map((entry) => maintainerName(entry).toLowerCase()))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function distTags(value, label) {
  const normalized = normalizeNpmView(value, 'object', `${label} dist-tags`);
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
    fail(`${label} dist-tags must be a JSON object`);
  }
  const result = {};
  for (const [name, version] of Object.entries(normalized)) {
    if (name.trim() === '' || typeof version !== 'string' || version.trim() === '') {
      fail(`${label} dist-tags contain an invalid entry`);
    }
    result[name] = version;
  }
  return result;
}

const arguments_ = process.argv.slice(2);
if (arguments_[0] === 'normalize') {
  const normalizeOptions = parseNormalizeArguments(arguments_.slice(1));
  const normalized = normalizeNpmView(
    readJson(normalizeOptions.input, 'npm view output'),
    normalizeOptions.type,
    'npm view output',
  );
  console.log(normalizeOptions.type === 'string' ? normalized : JSON.stringify(normalized));
  process.exit(0);
}

const options = parseArguments(arguments_);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.owner)) fail('owner is invalid');

const owners = maintainerNames(readJson(options.owners, 'maintainers'));
const expectedOwner = options.owner.toLowerCase();
if (!owners.includes(expectedOwner)) {
  fail('authenticated npm owner is not a package maintainer');
}
if (owners.length !== 1) fail('package maintainers must contain only the expected npm owner');
if (options.before === undefined) {
  console.log(JSON.stringify({ owner: options.owner }));
} else {
  if (!/^0\.0\.0-bootstrap\.[0-9]+$/u.test(options.version)) {
    fail('version must be a distinct bootstrap prerelease');
  }
  const before = distTags(readJson(options.before, 'before'), 'before');
  const after = distTags(readJson(options.after, 'after'), 'after');
  if (after.bootstrap !== options.version) {
    fail('bootstrap dist-tag does not match the requested version');
  }
  const latestBefore = before.latest ?? null;
  const latestAfter = after.latest ?? null;
  if (latestBefore !== latestAfter) fail('latest dist-tag changed during bootstrap');

  console.log(
    JSON.stringify({
      owner: options.owner,
      version: options.version,
      latestBefore,
      latestAfter,
      bootstrap: after.bootstrap,
    }),
  );
}
