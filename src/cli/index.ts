import cac from 'cac';
import { version } from '../core/version';

const cli = cac('scriptspect');

cli.help();
cli.version(version);

cli
  .command('[path]', 'Analyze package.json scripts for cross-platform portability')
  .action(() => {
    console.error(
      'scriptspect: the analyzer ships in milestone M2 (see docs/roadmap.md); this is the M0 bootstrap build.',
    );
    process.exitCode = 2;
  });

cli.parse();
