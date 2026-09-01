/**
 * PS026 — UNIX_PATH_ASSUMPTION: hardcoded Unix paths (/tmp, /usr/bin, …)
 * rarely exist on Windows.
 */
import { makeFinding } from '../core/finding';
import type { ParseMatrix } from '../parser/ir';
import type { Finding, RuleContext, RuleModule } from './types';
import { commandsOf } from './util';

const UNIX_PATH_PREFIXES = [
  '/tmp',
  '/usr',
  '/var',
  '/etc',
  '/opt',
  '/home',
  '/bin',
  '/sbin',
  '/lib',
];

export const PS026: RuleModule = {
  id: 'PS026',
  title: 'UNIX_PATH_ASSUMPTION',
  summary: 'Hardcoded Unix paths (/tmp, /usr/bin, …) do not exist on Windows.',
  severity: 'advisory',
  confidence: 'medium',
  affectedTargets: ['cmd', 'powershell'],
  badExamples: ['cp x /tmp/', 'mkdir /usr/local/etc/app'],
  goodExamples: ['mktemp -d', 'node scripts/tmpdir.js'],
  falsePositiveNotes:
    'Advisory only: absolute Unix paths are occasionally passed as opaque arguments to tools that interpret them elsewhere. Paths like /api used as URLs must not match (they do not: prefix list covers filesystem roots only).',
  fixSafety: 'manual',
  provenance: [
    {
      source:
        'https://learn.microsoft.com/en-us/windows/deployment/usmt/usmt-recognized-environment-variables',
      claim: 'Windows has no /tmp or /usr; equivalents live under %TEMP%, %ProgramFiles%.',
    },
  ],
  check(matrix, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const target of ['cmd', 'powershell'] as const) {
      if (!matrix.activeTargets.has(target)) continue;
      const containerPaths = findContainerPathEvidence(matrix, target);
      for (const cmd of commandsOf(matrix, target)) {
        for (const tok of cmd.argv) {
          const value = tok.value;
          const directPath = unixPathPrefix(value);
          const hostPath = containerPaths.hostPaths.get(spanKey(tok.span));
          if (directPath === undefined && hostPath === undefined) continue;
          if (containerPaths.internalSpans.some((span) => contains(span, tok.span))) continue;
          const finding = makeFinding(
            this,
            { ...ctx, targets: [target] },
            {
              message: `\`${directPath === undefined ? hostPath : value}\` assumes a Unix filesystem layout`,
              span: tok.span,
              fix: {
                ruleId: this.id,
                safety: 'manual',
                description:
                  'use os.tmpdir()/PATH lookup in a Node helper instead of hardcoded paths',
              },
            },
          );
          if (finding !== null) findings.push(finding);
        }
      }
    }
    return findings;
  },
};

type ContainerEngine = 'docker' | 'podman';
type ContainerFrontend = 'compose' | 'engine';
type ContainerSubcommand = 'exec' | 'run';

interface ContainerExecutable {
  engine: ContainerEngine;
  frontend: ContainerFrontend;
}

interface ContainerInvocation extends ContainerExecutable {
  executableIndex: number;
}

interface SupportedContainerCommand extends ContainerExecutable {
  subcommand: ContainerSubcommand;
  subcommandIndex: number;
}

const CONTAINER_EXECUTABLES = new Map<string, ContainerExecutable>([
  ['docker', { engine: 'docker', frontend: 'engine' }],
  ['docker.exe', { engine: 'docker', frontend: 'engine' }],
  ['docker-compose', { engine: 'docker', frontend: 'compose' }],
  ['docker-compose.exe', { engine: 'docker', frontend: 'compose' }],
  ['podman', { engine: 'podman', frontend: 'engine' }],
  ['podman.exe', { engine: 'podman', frontend: 'engine' }],
  ['podman-compose', { engine: 'podman', frontend: 'compose' }],
  ['podman-compose.exe', { engine: 'podman', frontend: 'compose' }],
]);
const SUDO_EXECUTABLES = new Set(['sudo', 'sudo.exe']);
const CONTAINER_SUBCOMMANDS = new Set(['exec', 'run']);
const GLOBAL_VALUE_OPTIONS = new Set([
  '--config',
  '--connection',
  '--context',
  '--host',
  '--identity',
  '--log-level',
  '--url',
  '-H',
  '-l',
]);
const GLOBAL_SWITCH_OPTIONS = new Set(['-D', '--debug', '--remote', '--tls', '--tlsverify']);
const ENGINE_GLOBAL_SWITCH_OPTIONS: Readonly<Record<ContainerEngine, ReadonlySet<string>>> = {
  docker: new Set(),
  podman: new Set(),
};
const COMPOSE_GLOBAL_VALUE_OPTIONS = new Set([
  '--ansi',
  '--env-file',
  '--file',
  '--parallel',
  '--profile',
  '--progress',
  '--project-directory',
  '--project-name',
  '-f',
  '-p',
]);
const COMPOSE_GLOBAL_SWITCH_OPTIONS = new Set([
  '--all-resources',
  '--compatibility',
  '--dry-run',
  '--help',
  '--version',
]);
const SUDO_VALUE_OPTIONS = new Set([
  '--chdir',
  '--chroot',
  '--close-from',
  '--command-timeout',
  '--group',
  '--host',
  '--prompt',
  '--role',
  '--type',
  '--user',
  '-C',
  '-D',
  '-g',
  '-h',
  '-p',
  '-R',
  '-r',
  '-T',
  '-t',
  '-u',
]);
const SUDO_SWITCH_OPTIONS = new Set([
  '--askpass',
  '--background',
  '--help',
  '--non-interactive',
  '--preserve-env',
  '--remove-timestamp',
  '--reset-timestamp',
  '--set-home',
  '--stdin',
  '--validate',
  '--version',
  '-A',
  '-b',
  '-E',
  '-H',
  '-K',
  '-k',
  '-n',
  '-S',
  '-v',
  '-V',
]);
const SUDO_SHORT_SWITCHES = new Set(['A', 'b', 'E', 'H', 'K', 'k', 'n', 'S', 'v', 'V']);
const CONTAINER_RUN_INTERNAL_VALUE_OPTIONS = new Set([
  '-w',
  '--workdir',
  '--entrypoint',
  '--tmpfs',
]);
const CONTAINER_RUN_VALUE_OPTIONS = new Set([
  '--add-host',
  '--annotation',
  '--attach',
  '--blkio-weight',
  '--cap-add',
  '--cap-drop',
  '--cgroup-parent',
  '--cgroupns',
  '--cidfile',
  '--cpu-period',
  '--cpu-quota',
  '--cpu-rt-period',
  '--cpu-rt-runtime',
  '--cpu-shares',
  '--cpus',
  '--cpuset-cpus',
  '--cpuset-mems',
  '--detach-keys',
  '--device',
  '--device-cgroup-rule',
  '--dns',
  '--dns-option',
  '--dns-search',
  '--domainname',
  '--entrypoint',
  '--env',
  '--env-file',
  '--expose',
  '--gpus',
  '--group-add',
  '--health-cmd',
  '--health-interval',
  '--health-retries',
  '--health-start-interval',
  '--health-start-period',
  '--health-timeout',
  '--hostname',
  '--ipc',
  '--isolation',
  '--label',
  '--label-file',
  '--link',
  '--log-driver',
  '--log-opt',
  '--mac-address',
  '--memory',
  '--memory-reservation',
  '--memory-swap',
  '--memory-swappiness',
  '--mount',
  '--name',
  '--network',
  '--network-alias',
  '--oom-score-adj',
  '--pid',
  '--pids-limit',
  '--platform',
  '--publish',
  '--pull',
  '--restart',
  '--runtime',
  '--security-opt',
  '--shm-size',
  '--stop-signal',
  '--stop-timeout',
  '--storage-opt',
  '--sysctl',
  '--tmpfs',
  '--ulimit',
  '--user',
  '--userns',
  '--volume',
  '--volumes-from',
  '--workdir',
  '-a',
  '-e',
  '-h',
  '-m',
  '-p',
  '-u',
  '-v',
  '-w',
]);
const CONTAINER_RUN_SWITCH_OPTIONS = new Set([
  '-d',
  '-i',
  '-P',
  '-t',
  '--detach',
  '--disable-content-trust',
  '--help',
  '--tty',
  '--init',
  '--interactive',
  '--no-healthcheck',
  '--no-hosts',
  '--oom-kill-disable',
  '--publish-all',
  '--privileged',
  '--read-only',
  '--rm',
  '--sig-proxy',
]);
const ENGINE_CONTAINER_RUN_SWITCH_OPTIONS: Readonly<Record<ContainerEngine, ReadonlySet<string>>> =
  {
    docker: new Set(['--use-api-socket']),
    podman: new Set(['--no-hostname', '--replace', '--tls-verify']),
  };
const CONTAINER_RUN_SHORT_SWITCHES = new Set(['d', 'i', 'P', 't']);
const CONTAINER_EXEC_INTERNAL_VALUE_OPTIONS = new Set(['--workdir', '-w']);
const CONTAINER_EXEC_VALUE_OPTIONS = new Set([
  '--detach-keys',
  '--env',
  '--env-file',
  '--user',
  '--workdir',
  '-e',
  '-u',
  '-w',
]);
const CONTAINER_EXEC_SWITCH_OPTIONS = new Set([
  '--detach',
  '--interactive',
  '--privileged',
  '--tty',
  '-d',
  '-i',
  '-t',
]);
const ENGINE_CONTAINER_EXEC_SWITCH_OPTIONS: Readonly<Record<ContainerEngine, ReadonlySet<string>>> =
  {
    docker: new Set(),
    podman: new Set(['--latest', '-l']),
  };
const CONTAINER_EXEC_SHORT_SWITCHES = new Set(['d', 'i', 't']);
const COMPOSE_RUN_INTERNAL_VALUE_OPTIONS = new Set(['--entrypoint', '--workdir', '-w']);
const COMPOSE_RUN_VALUE_OPTIONS = new Set([
  '--cap-add',
  '--cap-drop',
  '--entrypoint',
  '--env',
  '--env-from-file',
  '--label',
  '--name',
  '--publish',
  '--pull',
  '--user',
  '--volume',
  '--workdir',
  '-e',
  '-l',
  '-p',
  '-u',
  '-v',
  '-w',
]);
const COMPOSE_RUN_SWITCH_OPTIONS = new Set([
  '--build',
  '--detach',
  '--interactive',
  '--no-deps',
  '--no-tty',
  '--quiet',
  '--quiet-build',
  '--quiet-pull',
  '--remove-orphans',
  '--rm',
  '--service-ports',
  '--use-aliases',
  '-d',
  '-i',
  '-P',
  '-q',
  '-T',
]);
const COMPOSE_RUN_SHORT_SWITCHES = new Set(['d', 'i', 'P', 'q', 'T']);
const COMPOSE_EXEC_INTERNAL_VALUE_OPTIONS = new Set(['--workdir', '-w']);
const COMPOSE_EXEC_VALUE_OPTIONS = new Set([
  '--env',
  '--index',
  '--user',
  '--workdir',
  '-e',
  '-u',
  '-w',
]);
const COMPOSE_EXEC_SWITCH_OPTIONS = new Set([
  '--detach',
  '--interactive',
  '--no-tty',
  '--privileged',
  '-d',
  '-i',
  '-T',
]);
const COMPOSE_EXEC_SHORT_SWITCHES = new Set(['d', 'i', 'T']);
const EMPTY_OPTIONS = new Set<string>();

type ContainerArg = { value: string; span: [number, number] };

interface ContainerPathEvidence {
  internalSpans: [number, number][];
  hostPaths: Map<string, string>;
}

/** Container-internal ranges plus host paths embedded in docker/podman options. */
function findContainerPathEvidence(
  matrix: ParseMatrix,
  target: 'cmd' | 'powershell',
): ContainerPathEvidence {
  const evidence: ContainerPathEvidence = { internalSpans: [], hostPaths: new Map() };
  for (const command of commandsOf(matrix, target)) {
    const invocation = findContainerInvocation(command.argv, evidence);
    if (invocation === null) continue;
    const supported = findSupportedContainerCommand(command.argv, invocation, evidence);
    if (supported === null) continue;

    const boundary = findContainerBoundary(
      command.argv,
      supported.subcommandIndex + 1,
      supported,
      evidence,
    );
    if (boundary === -1) continue;
    const commandStart = command.argv[boundary + 1];
    const commandEnd = command.argv.at(-1);
    if (commandStart !== undefined && commandEnd !== undefined) {
      evidence.internalSpans.push([commandStart.span[0], commandEnd.span[1]]);
    }
  }
  return evidence;
}

function findContainerInvocation(
  argv: readonly ContainerArg[],
  evidence: ContainerPathEvidence,
): ContainerInvocation | null {
  let executableIndex = 0;
  const first = argv[0]?.value.toLowerCase();
  if (first !== undefined && SUDO_EXECUTABLES.has(first)) {
    executableIndex = findSudoPayload(argv, 1, evidence);
    if (executableIndex === -1) return null;
  }
  const executable = argv[executableIndex]?.value.toLowerCase();
  const container = executable === undefined ? undefined : CONTAINER_EXECUTABLES.get(executable);
  return container === undefined ? null : { ...container, executableIndex };
}

function findSudoPayload(
  argv: readonly ContainerArg[],
  start: number,
  evidence: ContainerPathEvidence,
): number {
  let index = start;
  while (index < argv.length) {
    const option = argv[index];
    if (option === undefined) return -1;
    if (option.value === '--') return index + 1 < argv.length ? index + 1 : -1;
    if (!option.value.startsWith('-')) return index;

    const width = optionWidth(
      option.value,
      SUDO_VALUE_OPTIONS,
      SUDO_SWITCH_OPTIONS,
      EMPTY_OPTIONS,
      SUDO_SHORT_SWITCHES,
    );
    if (width === null) {
      recordPotentialHostPathOptions(argv, index + 1, evidence);
      return -1;
    }
    index += width;
  }
  return -1;
}

function findSupportedContainerCommand(
  argv: readonly ContainerArg[],
  invocation: ContainerInvocation,
  evidence: ContainerPathEvidence,
): SupportedContainerCommand | null {
  if (invocation.frontend === 'compose') {
    const subcommandIndex = findComposeSubcommand(argv, invocation.executableIndex + 1, evidence);
    const subcommand = containerSubcommandAt(argv, subcommandIndex);
    return subcommand === null ? null : { ...invocation, subcommand, subcommandIndex };
  }
  return findEngineSubcommand(argv, invocation.executableIndex + 1, invocation.engine, evidence);
}

function findEngineSubcommand(
  argv: readonly ContainerArg[],
  start: number,
  engine: ContainerEngine,
  evidence: ContainerPathEvidence,
): SupportedContainerCommand | null {
  let index = start;
  while (index < argv.length) {
    const option = argv[index];
    if (option === undefined) return null;
    if (option.value === '--') return classifyEngineCommand(argv, index + 1, engine, evidence);
    if (!option.value.startsWith('-')) return classifyEngineCommand(argv, index, engine, evidence);

    const width = optionWidth(
      option.value,
      GLOBAL_VALUE_OPTIONS,
      GLOBAL_SWITCH_OPTIONS,
      ENGINE_GLOBAL_SWITCH_OPTIONS[engine],
    );
    if (width === null) {
      recordPotentialHostPathOptions(argv, index + 1, evidence);
      return null;
    }
    index += width;
  }
  return null;
}

function classifyEngineCommand(
  argv: readonly ContainerArg[],
  index: number,
  engine: ContainerEngine,
  evidence: ContainerPathEvidence,
): SupportedContainerCommand | null {
  const command = argv[index]?.value.toLowerCase();
  if (command === undefined) return null;
  const directSubcommand = containerSubcommandAt(argv, index);
  if (directSubcommand !== null) {
    return {
      engine,
      frontend: 'engine',
      subcommand: directSubcommand,
      subcommandIndex: index,
    };
  }
  if (command === 'container') {
    const subcommandIndex = findNamespacedContainerSubcommand(argv, index + 1, evidence);
    const subcommand = containerSubcommandAt(argv, subcommandIndex);
    return subcommand === null ? null : { engine, frontend: 'engine', subcommand, subcommandIndex };
  }
  if (command === 'compose') {
    const subcommandIndex = findComposeSubcommand(argv, index + 1, evidence);
    const subcommand = containerSubcommandAt(argv, subcommandIndex);
    return subcommand === null
      ? null
      : { engine, frontend: 'compose', subcommand, subcommandIndex };
  }
  return null;
}

function containerSubcommandAt(
  argv: readonly ContainerArg[],
  index: number,
): ContainerSubcommand | null {
  const value = argv[index]?.value.toLowerCase();
  return value === 'exec' || value === 'run' ? value : null;
}

function findNamespacedContainerSubcommand(
  argv: readonly ContainerArg[],
  start: number,
  evidence: ContainerPathEvidence,
): number {
  return findSimpleSubcommand(argv, start, EMPTY_OPTIONS, EMPTY_OPTIONS, EMPTY_OPTIONS, evidence);
}

function findComposeSubcommand(
  argv: readonly ContainerArg[],
  start: number,
  evidence: ContainerPathEvidence,
): number {
  return findSimpleSubcommand(
    argv,
    start,
    COMPOSE_GLOBAL_VALUE_OPTIONS,
    COMPOSE_GLOBAL_SWITCH_OPTIONS,
    EMPTY_OPTIONS,
    evidence,
    true,
  );
}

function findSimpleSubcommand(
  argv: readonly ContainerArg[],
  start: number,
  valueOptions: ReadonlySet<string>,
  switchOptions: ReadonlySet<string>,
  shortSwitches: ReadonlySet<string>,
  evidence: ContainerPathEvidence,
  recordHostPaths = false,
): number {
  let index = start;
  while (index < argv.length) {
    const option = argv[index];
    if (option === undefined) return -1;
    if (option.value === '--') {
      const candidate = argv[index + 1]?.value.toLowerCase();
      return candidate !== undefined && CONTAINER_SUBCOMMANDS.has(candidate) ? index + 1 : -1;
    }
    if (!option.value.startsWith('-')) {
      return CONTAINER_SUBCOMMANDS.has(option.value.toLowerCase()) ? index : -1;
    }

    const width = optionWidth(
      option.value,
      valueOptions,
      switchOptions,
      EMPTY_OPTIONS,
      shortSwitches,
    );
    if (width === null) {
      recordPotentialHostPathOptions(argv, index + 1, evidence);
      return -1;
    }
    const operand = width === 2 ? argv[index + 1] : undefined;
    if (recordHostPaths) recordContainerOptionPath(option, operand, evidence);
    index += width;
  }
  return -1;
}

function findContainerBoundary(
  argv: readonly ContainerArg[],
  start: number,
  command: SupportedContainerCommand,
  evidence: ContainerPathEvidence,
): number {
  const grammar = containerOptionGrammar(command);
  let index = start;
  while (index < argv.length) {
    const option = argv[index];
    if (option === undefined) return -1;
    if (option.value === '--') return index + 1 < argv.length ? index + 1 : -1;
    if (!option.value.startsWith('-')) return index;

    const width = optionWidth(
      option.value,
      grammar.valueOptions,
      grammar.switchOptions,
      grammar.engineSwitchOptions,
      grammar.shortSwitches,
    );
    if (width === null) {
      recordPotentialHostPathOptions(argv, index + 1, evidence);
      return -1;
    }
    const operand = width === 2 ? argv[index + 1] : undefined;
    const optionName = option.value.split('=', 1)[0] as string;
    if (grammar.internalValueOptions.has(optionName) && operand !== undefined) {
      evidence.internalSpans.push(operand.span);
    }
    recordContainerOptionPath(option, operand, evidence);
    index += width;
  }
  return -1;
}

interface ContainerOptionGrammar {
  engineSwitchOptions: ReadonlySet<string>;
  internalValueOptions: ReadonlySet<string>;
  shortSwitches: ReadonlySet<string>;
  switchOptions: ReadonlySet<string>;
  valueOptions: ReadonlySet<string>;
}

function containerOptionGrammar(command: SupportedContainerCommand): ContainerOptionGrammar {
  if (command.frontend === 'compose') {
    return command.subcommand === 'run'
      ? {
          engineSwitchOptions: EMPTY_OPTIONS,
          internalValueOptions: COMPOSE_RUN_INTERNAL_VALUE_OPTIONS,
          shortSwitches: COMPOSE_RUN_SHORT_SWITCHES,
          switchOptions: COMPOSE_RUN_SWITCH_OPTIONS,
          valueOptions: COMPOSE_RUN_VALUE_OPTIONS,
        }
      : {
          engineSwitchOptions: EMPTY_OPTIONS,
          internalValueOptions: COMPOSE_EXEC_INTERNAL_VALUE_OPTIONS,
          shortSwitches: COMPOSE_EXEC_SHORT_SWITCHES,
          switchOptions: COMPOSE_EXEC_SWITCH_OPTIONS,
          valueOptions: COMPOSE_EXEC_VALUE_OPTIONS,
        };
  }
  return command.subcommand === 'run'
    ? {
        engineSwitchOptions: ENGINE_CONTAINER_RUN_SWITCH_OPTIONS[command.engine],
        internalValueOptions: CONTAINER_RUN_INTERNAL_VALUE_OPTIONS,
        shortSwitches: CONTAINER_RUN_SHORT_SWITCHES,
        switchOptions: CONTAINER_RUN_SWITCH_OPTIONS,
        valueOptions: CONTAINER_RUN_VALUE_OPTIONS,
      }
    : {
        engineSwitchOptions: ENGINE_CONTAINER_EXEC_SWITCH_OPTIONS[command.engine],
        internalValueOptions: CONTAINER_EXEC_INTERNAL_VALUE_OPTIONS,
        shortSwitches: CONTAINER_EXEC_SHORT_SWITCHES,
        switchOptions: CONTAINER_EXEC_SWITCH_OPTIONS,
        valueOptions: CONTAINER_EXEC_VALUE_OPTIONS,
      };
}

function recordContainerOptionPath(
  option: { value: string; span: [number, number] },
  operand: { value: string; span: [number, number] } | undefined,
  evidence: ContainerPathEvidence,
  recordInternal = true,
): void {
  const equals = option.value.indexOf('=');
  const name = equals === -1 ? option.value : option.value.slice(0, equals);
  const value = equals === -1 ? operand?.value : option.value.slice(equals + 1);
  const span = equals === -1 ? operand?.span : option.span;
  if (value === undefined || span === undefined) return;

  let hostPath: string | undefined;
  if (name === '--mount') hostPath = bindMountSource(value);
  else if (name === '-v' || name === '--volume') {
    const volumeFields = value.split(':');
    if (recordInternal && volumeFields.length === 1) evidence.internalSpans.push(span);
    else hostPath = volumeFields[0];
  } else if (name === '--env-file' || name === '--env-from-file') hostPath = value;
  if (hostPath !== undefined && unixPathPrefix(hostPath) !== undefined) {
    evidence.hostPaths.set(spanKey(span), hostPath);
  }
}

function recordPotentialHostPathOptions(
  argv: readonly { value: string; span: [number, number] }[],
  start: number,
  evidence: ContainerPathEvidence,
): void {
  for (let index = start; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined) continue;
    const equals = option.value.indexOf('=');
    const name = equals === -1 ? option.value : option.value.slice(0, equals);
    if (
      name !== '--mount' &&
      name !== '-v' &&
      name !== '--volume' &&
      name !== '--env-file' &&
      name !== '--env-from-file'
    ) {
      continue;
    }
    const operand = equals === -1 ? argv[index + 1] : undefined;
    recordContainerOptionPath(option, operand, evidence, false);
    if (equals === -1 && operand !== undefined) index += 1;
  }
}

function bindMountSource(value: string): string | undefined {
  const fields = new Map(
    value.split(',').map((field) => {
      const equals = field.indexOf('=');
      return equals === -1 ? [field, ''] : [field.slice(0, equals), field.slice(equals + 1)];
    }),
  );
  if (fields.get('type') !== 'bind') return undefined;
  return fields.get('source') ?? fields.get('src');
}

function unixPathPrefix(value: string): string | undefined {
  return UNIX_PATH_PREFIXES.find((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function spanKey(span: [number, number]): string {
  return `${span[0]}:${span[1]}`;
}

function optionWidth(
  value: string,
  valueOptions: ReadonlySet<string>,
  commonSwitches: ReadonlySet<string>,
  engineSwitches: ReadonlySet<string>,
  shortSwitches: ReadonlySet<string> = EMPTY_OPTIONS,
): 1 | 2 | null {
  if (value.includes('=')) return 1;
  if (
    commonSwitches.has(value) ||
    engineSwitches.has(value) ||
    isShortSwitchBundle(value, shortSwitches)
  ) {
    return 1;
  }
  if (valueOptions.has(value)) return 2;
  return null;
}

function isShortSwitchBundle(value: string, switches: ReadonlySet<string>): boolean {
  return (
    value.length > 2 &&
    /^-[A-Za-z]+$/.test(value) &&
    [...value.slice(1)].every((char) => switches.has(char))
  );
}

function contains(outer: [number, number], inner: [number, number]): boolean {
  return outer[0] <= inner[0] && inner[1] <= outer[1];
}
