# Rules

Every rule is a stable public API. Each page is generated from rule metadata — never edited by hand.

| Rule | Title | Severity | Confidence | Affected |
| --- | --- | --- | --- | --- |
| [PS001](PS001.md) | POSIX_INLINE_ENV | error | high | cmd |
| [PS002](PS002.md) | CMD_SET_ENV | warn | high | posix-sh |
| [PS003](PS003.md) | POWERSHELL_ENV | warn | high | posix-sh, cmd |
| [PS010](PS010.md) | POSIX_RM | error | high | cmd |
| [PS011](PS011.md) | POSIX_CP | error | high | cmd |
| [PS012](PS012.md) | POSIX_MV | error | high | cmd |
| [PS013](PS013.md) | POSIX_MKDIR_P | error | high | cmd |
| [PS014](PS014.md) | POSIX_TOUCH | error | high | cmd |
| [PS015](PS015.md) | POSIX_CHMOD | warn | high | cmd, powershell |
| [PS016](PS016.md) | POSIX_WHICH | error | high | cmd |
| [PS017](PS017.md) | POSIX_GREP | warn | high | cmd |
| [PS018](PS018.md) | POSIX_SED | warn | high | cmd |
| [PS019](PS019.md) | POSIX_CAT | warn | high | cmd |
| [PS020](PS020.md) | COMMAND_SUBSTITUTION | error | high | cmd |
| [PS021](PS021.md) | POSIX_EXPORT | error | high | cmd |
| [PS022](PS022.md) | POSIX_SOURCE | error | high | cmd, powershell |
| [PS023](PS023.md) | POSIX_VAR_EXPANSION | warn | medium | cmd |
| [PS024](PS024.md) | CMD_VAR_EXPANSION | warn | high | posix-sh |
| [PS025](PS025.md) | DEV_NULL | warn | high | cmd, powershell |
| [PS026](PS026.md) | UNIX_PATH_ASSUMPTION | advisory | medium | cmd, powershell |
| [PS030](PS030.md) | EXPLICIT_BASH | warn | high | cmd |
| [PS031](PS031.md) | EXPLICIT_CMD | warn | high | posix-sh |
| [PS032](PS032.md) | EXPLICIT_POWERSHELL | warn | high | posix-sh |
| [PS040](PS040.md) | MISSING_LOCAL_BIN | warn | high | posix-sh, cmd, powershell |
| [PS041](PS041.md) | PLATFORM_EXE_SUFFIX | warn | high | posix-sh |
| [PS050](PS050.md) | SHELL_SPECIFIC_SEPARATOR | advisory | medium | cmd, posix-sh |
