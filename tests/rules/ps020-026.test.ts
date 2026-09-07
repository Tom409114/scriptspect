import { describe, expect, it } from 'vitest';
import { ids, only, run } from './helpers';

describe('PS020 COMMAND_SUBSTITUTION', () => {
  it('positive: $() constructs', () => {
    expect(ids(only(run('node $(npm bin)/jest'), 'PS020'))).toEqual(['PS020']);
    expect(only(run('echo "built at $(date)"'), 'PS020')).toHaveLength(1);
    expect(only(run('rm -rf $(ls dist)'), 'PS020')).toHaveLength(1);
  });

  it('negative: no substitution', () => {
    expect(only(run('node app.js'), 'PS020')).toEqual([]);
    expect(only(run('echo $HOME'), 'PS020')).toEqual([]);
    expect(only(run('echo "$(pwd)" && npx jest'), 'PS020')).toHaveLength(1); // exactly one, for the one $()
  });

  it('nested substitution counts once', () => {
    expect(only(run('echo $(dirname $(pwd))'), 'PS020')).toHaveLength(1);
  });
});

describe('PS021 POSIX_EXPORT', () => {
  it('positive: export statements', () => {
    expect(only(run('export NODE_ENV=production'), 'PS021')).toHaveLength(1);
    expect(only(run('export PATH=$PATH:./bin'), 'PS021')).toHaveLength(1);
    expect(only(run('npm i && export A=1 && node x'), 'PS021')).toHaveLength(1);
  });

  it('negative: strings and cross-env', () => {
    expect(only(run('echo "export A=1"'), 'PS021')).toEqual([]);
    expect(only(run('cross-env NODE_ENV=x node a'), 'PS021')).toEqual([]);
    expect(only(run('node app.js'), 'PS021')).toEqual([]);
  });
});

describe('PS022 POSIX_SOURCE', () => {
  it('positive: source and dot forms', () => {
    expect(only(run('source ./env.sh'), 'PS022')).toHaveLength(1);
    expect(only(run('. ./scripts/env.sh'), 'PS022')).toHaveLength(1);
    expect(only(run('source env.sh && npm t'), 'PS022')).toHaveLength(1);
  });

  it('negative: bare dot and unrelated', () => {
    expect(only(run('node app.js'), 'PS022')).toEqual([]);
    expect(only(run('echo source'), 'PS022')).toEqual([]);
    expect(only(run('vite build'), 'PS022')).toEqual([]);
  });
});

describe('PS023 POSIX_VAR_EXPANSION', () => {
  it('positive: $VAR forms', () => {
    expect(only(run('echo $npm_package_version'), 'PS023')).toHaveLength(1);
    expect(only(run('node build.js --out $' + '{OUT_DIR:-dist}'), 'PS023')).toHaveLength(1);
    expect(only(run('ls $HOME'), 'PS023')).toHaveLength(1);
  });

  it('negative: no dollar expansions', () => {
    expect(only(run('echo hello'), 'PS023')).toEqual([]);
    expect(only(run('vite build'), 'PS023')).toEqual([]);
  });

  it('negative: $env: belongs to PS003', () => {
    expect(only(run("$env:X='1'; node a"), 'PS023')).toEqual([]);
  });

  it('medium confidence, warn severity', () => {
    const [f] = only(run('echo $HOME'), 'PS023');
    expect(f?.confidence).toBe('medium');
    expect(f?.severity).toBe('warn');
  });
});

describe('PS024 CMD_VAR_EXPANSION', () => {
  it('positive: %VAR% forms', () => {
    expect(only(run('echo %APPDATA%'), 'PS024')).toHaveLength(1);
    expect(only(run('mkdir "%USERPROFILE%\\build"'), 'PS024')).toHaveLength(1);
    expect(only(run('node x --p %npm_package_version%'), 'PS024')).toHaveLength(1);
  });

  it('negative: format strings without closing percent', () => {
    expect(only(run("printf '%s\\n' hello"), 'PS024')).toEqual([]);
    expect(only(run('date +%Y-%m-%d'), 'PS024')).toEqual([]);
    expect(only(run('echo 100%'), 'PS024')).toEqual([]);
  });

  it('derives PowerShell as affected for cmd percent expansion syntax', () => {
    const [finding] = only(run('echo %TEMP%', { targets: ['powershell'] }), 'PS024');

    expect(finding?.affectedTargets).toEqual(['powershell']);
  });
});

describe('PS025 DEV_NULL', () => {
  it('positive: /dev/null in args and redirects', () => {
    expect(only(run('node heavy.js > /dev/null'), 'PS025')).toHaveLength(1);
    expect(only(run('cmd 2> /dev/null'), 'PS025')).toHaveLength(1);
    expect(only(run('cat /dev/null'), 'PS025')).toHaveLength(1);
  });

  it('negative: regular files', () => {
    expect(only(run('node heavy.js > out.log'), 'PS025')).toEqual([]);
    expect(only(run('echo /dev'), 'PS025')).toEqual([]);
    expect(only(run('vite build'), 'PS025')).toEqual([]);
  });
});

describe('PS026 UNIX_PATH_ASSUMPTION', () => {
  it('positive: hardcoded unix paths', () => {
    expect(only(run('cp x /tmp/'), 'PS026')).toHaveLength(1);
    expect(only(run('mkdir /usr/local/etc/app'), 'PS026')).toHaveLength(1);
    expect(only(run('ls /var/log'), 'PS026')).toHaveLength(1);
  });

  it('negative: relative paths and urls', () => {
    expect(only(run('cp x ./tmp/'), 'PS026')).toEqual([]);
    expect(only(run('curl http://x/api/y'), 'PS026')).toEqual([]);
    expect(only(run('node app.js'), 'PS026')).toEqual([]);
  });

  it.each([
    "docker exec ghost-dev bash -c 'cd /home/ghost/ghost/core && node index.js'",
    "podman exec app sh -c 'cat /etc/app/config'",
    "docker run --rm app /bin/sh -c 'ls /var/log'",
    "podman run app bash -lc 'test -f /opt/app/config'",
  ])('does not treat a container-shell path in %s as a host path', (script) => {
    expect(only(run(script), 'PS026')).toEqual([]);
  });

  it.each([
    'docker exec --workdir /home/ghost/ghost/core ghost-dev pnpm knex-migrator rollback',
    'podman run --workdir /opt/app --rm app node index.js',
  ])('does not treat a container workdir in %s as a host path', (script) => {
    expect(only(run(script), 'PS026')).toEqual([]);
  });

  it('still reports a host bind-mount path outside the container shell payload', () => {
    const findings = only(
      run("docker run --rm -v /home/me/data:/data app sh -c 'cat /etc/app/config'"),
      'PS026',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('/home/me/data:/data');
  });

  it.each([
    "docker run --entrypoint bash -v /home/me/data:/data app -c 'cat /etc/app/config'",
    'docker run --name bash -v /home/me/data:/data app tool -c /etc/app/config',
  ])('does not let a shell-valued option hide the host bind source in %s', (script) => {
    const findings = only(run(script), 'PS026');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('/home/me/data:/data');
  });

  it.each([
    'docker exec --user 1000 --workdir /home/app app cat /etc/app/config',
    'podman run --name demo --workdir /opt/app image node /usr/bin/tool',
    'docker run --entrypoint /bin/sh image -c /etc/app/config',
    'docker run --tmpfs /home/cache:noexec image node /usr/bin/tool',
  ])('treats container option values and command arguments as internal in %s', (script) => {
    expect(only(run(script), 'PS026')).toEqual([]);
  });

  it('reports only the host bind source when workdir and command arguments are internal', () => {
    const findings = only(
      run('docker run -v /home/me/data:/data --workdir /opt/app app node /usr/bin/tool'),
      'PS026',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('/home/me/data:/data');
  });

  it.each([
    'docker run -v /home/me/data:/data image node index.js',
    'docker run --volume /home/me/data:/data image node index.js',
    'docker run --volume=/home/me/data:/data image node index.js',
    'docker run --env-file /home/me/app.env image node index.js',
    'docker run --env-file=/home/me/app.env image node index.js',
  ])('keeps host-file option values reportable in %s', (script) => {
    expect(only(run(script), 'PS026')).toHaveLength(1);
  });

  it('reports the host source inside a bind-mount option', () => {
    const findings = only(
      run('docker run --mount type=bind,source=/home/me/data,target=/data image node index.js'),
      'PS026',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('/home/me/data');
  });

  it('recognizes the short bind-mount source spelling', () => {
    const findings = only(
      run('docker run --mount type=bind,src=/home/me/data,target=/data image node index.js'),
      'PS026',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('/home/me/data');
  });

  it.each([
    'docker run --mount type=volume,source=/home/me/data,target=/data image node index.js',
    'docker run --mount bind,source=/home/me/data,target=/data image node index.js',
    'docker run -v cache:/data image node index.js',
    'docker run --mount',
    'docker run --mount=type=bind image node index.js',
  ])('does not invent a host Unix path for %s', (script) => {
    expect(only(run(script), 'PS026')).toEqual([]);
  });

  it.each([
    'docker --debug run --rm image /usr/bin/tool',
    'docker -- run image /usr/bin/tool',
    'docker run -- image /usr/bin/tool',
  ])('finds the container boundary through global or command delimiters in %s', (script) => {
    expect(only(run(script), 'PS026')).toEqual([]);
  });

  it('classifies Docker payloads independently for cmd and PowerShell', () => {
    const script = "docker run image sh -c 'echo ok && cat /etc/hosts'";

    expect(only(run(script, { targets: ['cmd'] }), 'PS026')).toEqual([
      expect.objectContaining({ affectedTargets: ['cmd'] }),
    ]);
    expect(only(run(script, { targets: ['powershell'] }), 'PS026')).toEqual([]);
  });

  it('honors cmd caret escaping when classifying a Docker payload', () => {
    const script = 'docker run image sh -c echo ^& cat /etc/hosts';

    expect(only(run(script, { targets: ['cmd'] }), 'PS026')).toEqual([]);
  });

  it('treats a one-field volume as a container destination, not a host source', () => {
    expect(only(run('docker run -v /home/app image node index.js'), 'PS026')).toEqual([]);
  });

  it.each([
    'docker run --disable-content-trust image node /usr/bin/tool',
    'podman run --no-hosts image node /usr/bin/tool',
  ])('does not let a boolean run option consume the image boundary in %s', (script) => {
    expect(only(run(script), 'PS026')).toEqual([]);
  });

  it.each([
    'docker run --disable-content-trust -v /home/me/data:/data image node index.js',
    'podman run --no-hosts -v /home/me/data:/data image node index.js',
  ])('keeps a host bind visible after a boolean run option in %s', (script) => {
    expect(only(run(script), 'PS026')).toHaveLength(1);
  });

  it.each([
    'podman run --tls-verify image /bin/sh -c /etc/app/config',
    'podman run --no-hostname image /bin/sh -c /etc/app/config',
    'podman run --replace image /bin/sh -c /etc/app/config',
    'docker run --use-api-socket image /bin/sh -c /etc/app/config',
  ])('does not let an engine-specific boolean option consume the image in %s', (script) => {
    expect(only(run(script), 'PS026')).toEqual([]);
  });

  it('keeps a host bind visible after a Docker boolean option', () => {
    expect(
      only(
        run(
          'docker run --use-api-socket --mount type=bind,source=/home/me,target=/data image node',
        ),
        'PS026',
      ),
    ).toEqual([expect.objectContaining({ message: expect.stringContaining('/home/me') })]);
  });

  it('keeps an explicit host bind reportable after an option with unknown arity', () => {
    expect(
      only(
        run('docker run --future-switch --mount type=bind,source=/home/me,target=/data image node'),
        'PS026',
      ),
    ).toEqual([expect.objectContaining({ message: expect.stringContaining('/home/me') })]);
  });

  it.each([
    "docker container run image sh -c 'cat /etc/app/config'",
    'docker container exec app cat /etc/app/config',
    "podman container run image sh -c 'cat /etc/app/config'",
    'podman container exec app cat /etc/app/config',
    "docker-compose run service sh -c 'cat /etc/app/config'",
    'docker-compose exec service cat /etc/app/config',
    "docker compose run service sh -c 'cat /etc/app/config'",
    'docker compose exec -T service cat /etc/app/config',
    'docker compose run -q service cat /etc/app/config',
    'docker-compose run -P service cat /etc/app/config',
    'docker compose run --quiet-build service cat /etc/app/config',
    "podman-compose run service sh -c 'cat /etc/app/config'",
    'podman compose exec service cat /etc/app/config',
    "sudo docker run image sh -c 'cat /etc/app/config'",
    'sudo -n podman exec app cat /etc/app/config',
    'sudo -u root docker container run image cat /etc/app/config',
    'sudo docker compose exec -T service cat /etc/app/config',
    'sudo podman container run image cat /etc/app/config',
  ])('recognizes a wrapped or namespaced container payload in %s', (script) => {
    expect(only(run(script), 'PS026')).toEqual([]);
  });

  it.each([
    'docker container run --mount=type=bind,source=/home/me/data,target=/data image node',
    'podman container run --env-file=/home/me/app.env image node',
    'docker-compose run --volume=/home/me/data:/data service node',
    'docker compose --env-file=/home/me/app.env run service node',
    'podman compose run --env-from-file=/home/me/app.env service node',
    'sudo docker run --mount type=bind,source=/home/me/data,target=/data image node',
    'sudo docker compose run --volume=/home/me/data:/data service node',
  ])('keeps wrapped or namespaced host-path evidence visible in %s', (script) => {
    expect(only(run(script), 'PS026')).toHaveLength(1);
  });

  it.each([
    'sudo --future-switch docker run --mount=type=bind,source=/home/me,target=/data image node',
    'docker container --future-switch run --mount=type=bind,source=/home/me,target=/data image node',
    'docker compose --future-switch run --volume=/home/me:/data service node',
    'docker-compose run --future-switch --volume=/home/me:/data service node',
  ])('keeps explicit host evidence after an ambiguous wrapper option in %s', (script) => {
    expect(only(run(script), 'PS026')).toHaveLength(1);
  });

  it('does not suppress a possible host path after an ambiguous sudo option', () => {
    expect(
      only(run('sudo --future-switch docker run image /bin/sh -c /etc/app/config'), 'PS026'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('/bin/sh') }),
      ]),
    );
  });

  it.each(['docker --debug /usr/bin/tool', 'docker -- /usr/bin/tool', 'docker ps /usr/bin/tool'])(
    'does not suppress a host path when no supported container command exists in %s',
    (script) => {
      expect(only(run(script), 'PS026')).toHaveLength(1);
    },
  );

  it.each(['docker --', 'docker run --', 'docker run --workdir /opt/app'])(
    'fails closed without crashing on an incomplete container command in %s',
    (script) => {
      expect(only(run(script), 'PS026')).toEqual([]);
    },
  );

  it.each(['docker exec app cat /etc/app/config', 'docker run --rm app node /usr/bin/tool'])(
    'does not treat a direct container command path in %s as a host path',
    (script) => {
      expect(only(run(script), 'PS026')).toEqual([]);
    },
  );

  it('advisory severity', () => {
    const [f] = only(run('ls /tmp'), 'PS026');
    expect(f?.severity).toBe('advisory');
  });
});
