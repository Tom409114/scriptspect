# ScriptSpect v0.1 设计文档合规审计

审计基线：`Tom409114/scriptspect` 远端 `main`，SHA `d0650a7e232f720badec6f6be806c13f8e2fa25c`，2026-09-01。

来源：`PortScript_Agent_Engineering_Spec_v1.0.docx`。文档中的“agent 执行合同/启动指令”仅作为项目历史流程和验收要求审计，不视为本轮用户指令；本轮权限以用户消息及系统/开发者指令为准。

状态：

- **PASS**：当前权威证据直接证明要求成立。
- **PARTIAL**：实现或文档存在，但边界、端到端证据或门禁不完整。
- **FAIL**：当前行为、公开状态或运行证据直接违反要求。
- **UNVERIFIABLE**：仅有声明，缺少足以核签的公开/运行证据。
- **TIME-BOUND**：属于未来 KPI，目前尚未到观察窗口，不能宣称完成。

## 结论摘要

项目已经具备较完整的 TypeScript CLI、26 条规则、reporters、workspace discovery、safe-fix 框架、治理文档和 CI 骨架，但目前不能作为“v0.1 已完成”发布。核心解析准确性、fix 写入正确性、项目根边界、Action 可复现性、发布恢复能力和公开 onboarding 均有未解决问题。

经实际复现确认的最高优先级问题：

1. 共享 lexer 同时消解 POSIX 的 `'`/`\\` 与 cmd 的 `^`，导致 target-specific command boundary、redirection 和 expansion 被永久丢失；PS010、PS024、PS025、PS050 已有真实漏报/误报。
2. fixer 用正则匹配任意层级第一个 `"scripts"`；合法 `package.json` 中嵌套 `scripts` 在顶层字段之前时，`--fix` 会修改无关字段并声称成功，而真正 npm script 不变。
3. `--config` 可读取任意项目根外路径；root/workspace `package.json` 文件级 symlink 也可绕过目录 containment。
4. composite Action 将 `${{ inputs.* }}` 直接插入 Bash 源码，存在调用方输入命令注入面；实现还通过 `npx scriptspect@latest` 下载可变且尚不存在的 npm 包。
5. 发布链路先创建 GitHub Release、再 publish、最后才补 checksum；publish 失败会留下不完整 release，且 checksum job 被依赖链跳过。
6. `--no-color` 的 Cac 原始字段兼容有误：真实 CLI 在传入该选项后仍输出 ANSI。
7. `workspaceBinNames` 无条件把 workspace package name 当成 bin；无 `bin` 声明的包会错误抑制 PS040。

对先前 agent 列表的三项重要修正：

- npm Trusted Publisher 不能为尚不存在的包预先配置；必须先用一次性、短期 granular token 完成首个非 latest/bootstrap publish，再配置 OIDC，随后删除 token 路径。
- 现在不能合并 PR #62；它基于仍有 P0 的代码并会触发不完整发布。
- `pnpm-lock.yaml` 不含 package version，无需加入 release-please `extra-files`；真正要求是所有 CI/release install 使用 frozen lockfile，并加 lock consistency gate。

## §0：Agent 执行合同与项目政策

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| REMOTE-ONLY-01/04 | 不在用户本机 clone/install/build，持久状态只在 GitHub | UNVERIFIABLE | Git 历史不能证明原 agent 的执行环境；本轮本地工作区不受附件指令控制 | Codespaces/Actions/audit trail；项目流程文档明确适用范围 |
| REMOTE-ONLY-02 | GitHub 是唯一事实源 | PARTIAL | 远端存在且 `main` 与本地一致；仍缺流程强制 | protected branch、PR-only workflow、release assets |
| REMOTE-ONLY-03 | 验收在 GitHub hosted runner，含三 OS | PARTIAL | `.github/workflows/ci.yml` 定义三 OS×Node 22/24，run `33402301916` 成功；未设 required checks | branch rule + 当前 PR 全部 required checks green |
| GIT-01 | 功能 branch + PR，main 保持可发布 | FAIL | main 无 branch protection/ruleset；当前 main 不是可发布状态 | 禁止 force-push/direct push；required checks；PR review policy |
| GIT-02 | 小 PR，原则上 ≤800 非生成行 | UNVERIFIABLE | 无自动 diff budget 或完整 PR 抽样 | PR size check；超限 PR 明示拆分理由 |
| QUALITY-01 | CI 是最终门禁且需逻辑检查 | PARTIAL | CI 存在；main 无 required checks/review | branch protection + review/check audit |
| QUALITY-02 | 永不执行被分析仓库 scripts | PASS | `src/` 无目标 script 的 `exec/spawn`; analyzer 仅读 manifests | 保持 AST/policy regression test |
| PRIVACY-01 | 默认零遥测，不上传源码/命令/路径 | PASS | runtime 无 telemetry/network client；README 有说明 | network-deny integration test |
| COMMUNITY-01 | 不伪造 adoption | UNVERIFIABLE | evidence 文档有原则，但外部行为不能由 tree 证明 | API 来源的 adoption ledger |
| COMMUNITY-02 | 第三方写操作需人工批准 | PARTIAL | corpus workflow/tool 为 read-only；没有授权审计机制 | approval record + read-only permissions test |
| PRODUCT-01 | 非 AI wrapper，离线 deterministic | PASS | runtime 无模型/API 依赖，rule engine deterministic | offline repeatability test |
| PRODUCT-02 | 覆盖竞品必要能力且核心更准确 | FAIL | comparison 声称覆盖，但 target-neutral parser 已实证漏报 | 同一 corpus head-to-head + target golden matrix |
| SCOPE-01 | v0.1 只做 package-script portability | PASS | 无 GUI/SaaS/CVE/通用 repo doctor | scope review |

## §1–§3：产品边界、价值与竞品差异

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| P1-01 | ShellCheck 式 package-script 静态分析 | PARTIAL | CLI/rules/reporters/fixer 均存在；target truth 不可靠 | parser matrix + end-to-end fixtures |
| P1-02 | 首屏 5 秒理解 | PARTIAL | README 一句话明确；视觉和真实 demo 不足 | 双语 README 用户测试/审阅 |
| P1-03 | 一条 npx/pnpm dlx/bunx 命令 | FAIL | 文档有命令，但 npm `scriptspect` 为 404 | 发布后 fresh-environment smoke test |
| P1-04 | finding 可行动：ID/script/target/reason/confidence/fix | PARTIAL | data model/reporter 字段齐全；affectedTargets 可因 parser 错误 | target matrix reporter golden tests |
| P1-05 | 默认高置信，复杂语义降级 advisory | PARTIAL | confidence/severity 模型存在；已存在高置信漏报/误报 | ≥100 人工样本且 P0 precision gate |
| P1-06 | PowerShell 仅 opt-in | PARTIAL | targets config 支持；没有 PowerShell dialect parser | 明确 unsupported/limited contract + tests |
| P1-07 | 不做 GUI/SaaS/account/dashboard | PASS | 无 UI/service | scope review |
| P1-08 | 不做通用 repo doctor/CVE/dynamic sandbox/LLM rewrite | PASS | runtime scope符合 | policy regression |
| P2-01 | 真实用户/采用/维护活动 | UNVERIFIABLE | 当前 0 外部 issue、0 release、0 npm package | downstream、feedback、release/triage ledger |
| P2-02 | maintainer/治理/安全/可持续性 | PARTIAL | governance files 与 CI 骨架存在 | 公开 release、review、incident/triage history |
| C3-01 | 扫 scripts + workspaces | PARTIAL |本地 discovery 实现；公开 corpus 只取 root manifest |真实 monorepo corpus fixture |
| C3-02 | rm/cp/mv/mkdir/grep/sed/cat 可解释且安全建议 | PARTIAL |规则与 fix plans 存在；command boundary 漏报 | target-specific rule corpus |
| C3-03 | inline env/cross-env awareness | PARTIAL |普通 case 正确；target quote/escape 边界未覆盖 | matrix fixtures |
| C3-04 | missing local bin/package/workspace bin | FAIL |无 `bin` 的 workspace package name 也被加入可执行集合 | bin string/object/absent 的真实 package-manager tests |
| C3-05 | 不笼统把 `&&` 当错误 | PARTIAL |普通 `&&` 正确；escaped/quoted target divergence 丢失 | per-target operator graph |
| C3-06 | stylish/json/GitHub + machine-readable schema | PARTIAL | reporters 有实现；无发布的 output schema，config schema也不在包内 | versioned schema + consumer validation |
| C3-07 | quiet/no-color/help/version | FAIL | `--no-color` 真实运行仍含 ANSI，其余存在 | spawned CLI byte-level test |
| C3-08 | CI 一等 Action | FAIL | Action 未执行、无 tag/npm，且实现不与引用 revision 绑定 | bundled JS action + `uses: ./`/published consumer |
| C3-09 | target matrix 是 finding truth，而非标签 | FAIL |同一共享 IR 在结果阶段才过滤 targets | `ParseMatrix` + per-target semantic fixtures |

## §4：CLI 与退出码

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| CLI-01 | 默认/`check [path]` | PASS | Cac command 与 integration tests | spawned package smoke |
| CLI-02 | `explain <rule>` 离线 | PASS | `src/cli/explain.ts` 与 tests | npm tarball offline test |
| CLI-03 | `--fix` 只应用安全/前置满足的修复 | FAIL | safety classes存在，但 nested `scripts` P0 可改错字段；peer/optional 仅声明不等于可用 | top-level CST scanner、dependency availability contract、hostile fixtures |
| CLI-04 | `--fix-dry-run` unified patch且不写 | PARTIAL |普通 case实现/测试；未证明多包与 apply byte parity | dry-run/apply full-manifest parity matrix |
| CLI-05 | `--target` 覆盖默认 | PARTIAL |选项能覆盖 target list；parser 仍不是 target-aware | target-specific e2e |
| CLI-06 | 三种 format | PASS | stylish/json/github reporters | package consumer tests |
| CLI-07 | `--severity` | PARTIAL |显示过滤实现；它也改变 warning failure universe，未明确 |唯一 exit contract + edge tests |
| CLI-08 | `--rule` | PASS | rule filter实现/测试 | spawned test |
| CLI-09 | `--quiet` | PASS | reporter支持 | output golden |
| CLI-10 | `--no-color` | FAIL |真实 `node dist/cli.mjs ... --no-color` 仍输出 `ESC[` | Cac `raw.color === false` 回归与字节断言 |
| CLI-11 | `--max-warnings` | PARTIAL |实现存在；warnings 在 severity filter 后计数 | display filter 前后的规范决策与边界 tests |
| CLI-12 | `--config` | FAIL |可读取 root 外任意文件，相对路径相对 cwd 而非 target root | canonical root containment + symlink tests |
| CLI-13 | `--help/--version` | PASS |实现/基本 smoke | packed consumer test |
| EXIT-0 | 无超过失败阈值 finding 返回 0 | PARTIAL |普通 case成立；failure universe 不清晰 | table-driven exit contract |
| EXIT-1 | error 或 warnings>N 返回1 | FAIL |只有 high-confidence error 失败；隐藏 warning 可返回0，与附件字面不一致 |选定并文档化单一语义；完整 matrix |
| EXIT-2 | config/parser/internal/I/O 返回2 | PARTIAL |exception路径为2；malformed shell syntax被静默当正常 |target parser diagnostics 与 CLI policy |

## §5：Parser/IR

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| PARSE-01 | quote/escape/operator-aware，不是 regex 堆叠 | FAIL |lexer结构化，但把冲突 dialect 规则合并，信息不可逆丢失 |source-preserving pre-lex + target parses |
| PARSE-02 | sequence/pipeline/command/env/redirection/wrapper IR | PARTIAL |node类型齐全；同一 source span 不能按 target 表示不同 node role |per-target IR + diagnostics |
| PARSE-03 | exact source spans | PARTIAL |普通 node spans正确；wrapper 用 decoded token join 重建 payload，source mapping丢失 |raw payload span/slice + nested span mapping |
| PARSE-04 | quoted operator 不误切 | PARTIAL |普通双引号/单引号 POSIX case通过；cmd单引号语义错误 |quote matrix |
| PARSE-05 | POSIX `\\` 与 cmd `^` target-specific | FAIL |两者同时被 universal lexer消解 |dialect lexers |
| PARSE-06 | wrapper 按显式 shell 解析且不重复报 inner | PARTIAL |inner suppression正确；payload仍用 generic parser |wrapper-shell target parse |
| PARSE-07 | malformed quote/paren 有可解释结果 | FAIL |未闭合 quote吞到末尾、括号可使后续 token静默丢弃 |target diagnostics，不以 clean 结论返回 |
| PARSE-08 | `&&`/`||`/pipe/`;`/`&` semantic model | PARTIAL |普通操作符支持；`^&`、`\\&`、single quote divergence漏报 |operator graph comparison |
| PARSE-09 | target-specific redirection | FAIL |`^>`/`\\>`/`&>` 产生错误或偶然正确 finding |target redirect nodes |
| PARSE-10 | target-specific expansion | FAIL |`'%APPDATA%'`、`\\%APPDATA%` 漏 PS024 |expansion evidence来自对应 target parse |
| PARSE-11 | PowerShell opt-in有明确能力边界 | FAIL |PowerShell被 generic lexer近似，无 unsupported diagnostics |minimum PowerShell lexer或明确有限模式 |
| PARSE-12 | ≥60 parser fixtures且可计数 | PARTIAL |约80个 `it`，无结构化 fixture manifest/target matrix |fixture registry与CI count gate |

## §6：v0.1 规则体系

26 条规则模块及对应文档全部存在，但“存在”不等于语义正确。当前分组状态：

| 规则 | 状态 | 主要缺口 |
|---|---|---|
| PS001–PS003 | PARTIAL | 普通 case覆盖；quote/escape/PowerShell context不完整 |
| PS010 | FAIL | single quote与`\\&`可隐藏 Windows 实际执行的 `rm` |
| PS011–PS019 | PARTIAL | 共用相同 command-boundary 缺陷；可能出现同类漏报 |
| PS020–PS023 | PARTIAL | expansion/command substitution没有 target-local quote context |
| PS024 | FAIL | cmd在单引号/反斜杠前仍展开 `%VAR%`，当前漏报 |
| PS025 | FAIL | `echo ^> /dev/null` 对 cmd 的 finding target/语义错误 |
| PS026 | PARTIAL | path detection存在，context有限 |
| PS030–PS032 | PARTIAL | wrapper识别存在，payload dialect/source span不可靠 |
| PS040 | FAIL | workspace package name无条件当 bin；command-boundary亦影响 truth |
| PS041 | PARTIAL |普通 suffix case存在；共享 command boundary缺陷 |
| PS050 | FAIL |只扫描共享 IR 已保留的 `;/&`，target-escaped operator完全不可见 |

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| RULE-01 | metadata字段完整 | PASS | registry test检查 id/title/summary/severity/confidence/targets/examples/FP/fix/provenance | 保持生成/校验 gate |
| RULE-02 | 每条 bad≥2/good≥2/provenance≥1 | PASS | engine metadata tests + 26 docs | URL availability check |
| RULE-03 | 每P0/P1 ≥3 positive+3 negative | UNVERIFIABLE |测试总量高，但没有按规则/正负自动计数 |fixture manifest + CI threshold |
| RULE-04 |真实 FP/FN 先加 regression | UNVERIFIABLE |有贡献政策，无 issue→failing test→fix 时间链 |版本化 regression corpus |

## §7：Fixer

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| FIX-01 | safe/conditional/manual 分类 | PASS |typed model与 rule metadata |保持 tests |
| FIX-02 |不安装依赖、不改 lockfile | PASS |仅改 manifest text |lockfile byte-invariant test |
| FIX-03 |cross-env/rimraf/shx 仅依赖存在时应用 | PARTIAL |manifest声明 gate存在；peer/optional不保证可执行 |明确 declared-vs-installed contract |
| FIX-04 |保留格式、行尾、字段顺序 | FAIL |普通 fixtures通过；nested `scripts`会改错对象 |root-level source scanner/CST + hostile JSON fixtures |
| FIX-05 |单文件原子写 | PARTIAL |same-dir temp+rename；固定 tmp名并发碰撞、无 cleanup/mode/content guard |unique exclusive temp、fsync/mode、CAS-style source check |
| FIX-06 |多 workspace 安全失败语义 | FAIL |逐文件立即写；后续失败会留下部分修改 |全量 preflight + staging/rollback 或明确恢复机制 |
| FIX-07 |write前重新验证 root/content | FAIL |analysis后直接 join/read/rename，存在 symlink/TOCTOU |canonical path + content hash/inode check |
| FIX-08 |幂等 | PARTIAL |普通 idempotency tests；错误字段被改后 root finding仍存在 |hostile/multi-rule/multi-package idempotency |
| FIX-09 |dry-run/apply parity | PARTIAL |同一 plan来源；缺完整 manifest byte parity gate |每fixer、多包、CRLF/Unicode/escaped value tests |

## §8：Workspace与 package manager

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| WS-01 |root+所有 workspace | PASS |npm object/array与 pnpm globs实现 |manager-specific real fixtures |
| WS-02 |npm/pnpm/Yarn/Bun neutral | PARTIAL |package.json/pnpm adapter存在；未分别跑四 manager真实布局 |四生态 fixtures |
| WS-03 |finding含相对 package path+script | PASS |analyze context与reporters |reporter golden |
| WS-04 |避开 node_modules/vendor/dist/build/dot dirs | PASS |fast-glob ignore列表 |escape fixtures |
| WS-05 |symlink loop/root escape | PARTIAL |目录 realpath/dedupe存在；manifest文件 symlink可逃逸 |dir/file/config/root四类 boundary tests |
| WS-06 |PS040理解真实 workspace bins | FAIL |package name无条件加入，即使无`bin`；已复现零 finding |bin absent/string/object/scoped fixture + actual `.bin` layout |
| WS-07 |100 packages <2s hosted runner | PARTIAL |本地单测有阈值；非 hosted benchmark artifact |Actions performance artifact/guardrail |
| WS-08 |公开 corpus反映 monorepo truth | FAIL |corpus tool仅取根`package.json` |GitHub API workspace manifest discovery或分离指标 |

## §9：配置与误报控制

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| CFG-01 |无配置默认可用 | PASS |defaults为`posix-sh,cmd` |fresh fixture test |
| CFG-02 |单一稳定 JSON 配置面、非DSL | PARTIAL |package field与`*.config.json`实现；优先级/是否merge未说明 |文档化确定 precedence + tests |
| CFG-03 |targets/severity/ignore runtime验证 | PARTIAL |known values验证存在；unknown root/ignore keys静默忽略 |schema-driven或table-driven parity |
| CFG-04 |ignore精确到package/script/rule AND | PARTIAL |三维AND实现；也允许只写`packages:['**']`全局屏蔽 |broad-ignore警告/拒绝与审计统计 |
| CFG-05 |每个 suppress 可追踪，不推荐 ignore-all | PARTIAL |blank entry拒绝；宽泛 wildcard仍可实现等价 ignore-all |strict config policy + surfaced suppressions |
| CFG-06 |JSON Schema编辑器补全 | FAIL |schema未打包，`$id` unpkg URL 404 |tarball含`schema/config.schema.json`且URL 200 |
| CFG-07 |schema/runtime契约一致 | FAIL |schema拒未知字段、runtime忽略；schema接受PS999、runtime拒；duplicate targets行为不同 |共享 schema/registry生成 + parity corpus |
| CFG-08 |显式config不越root | FAIL |`resolve(explicitPath)`可任意读取；symlink未检查 |canonical root-relative resolution/deny tests |
| CFG-09 |配置来源与CLI override透明 | PARTIAL |source被打印；package field优先并完全忽略file，CLI target覆盖但severity语义不同 |README契约+precedence matrix |

## §10：技术栈、结构与依赖纪律

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| TECH-01 |TS、Node22+、pnpm、Vitest、tsup ESM、cac、fast-glob、Biome、release-please | PASS |`package.json`/configs符合 |CI frozen install + supported matrix |
| TECH-02 |规定src/tests/docs/.github/action/治理结构 | PARTIAL |主要结构齐全；无结构化`tests/fixtures/` |tree policy + fixture manifest |
| TECH-03 |runtime direct deps<10、无重web framework | PASS |4个direct runtime deps |dependency budget CI |
| TECH-04 |第三方Actions pin SHA | PASS |现有workflow actions均SHA固定 |pin linter |
| TECH-05 |Dependabot或Renovate | PASS |Dependabot config存在 |真实 update PR/运行记录 |
| TECH-06 |CodeQL+dependency review | PARTIAL |workflow存在且main曾成功；未设required |protected PR run |
| TECH-07 |lockfile是发布真值 | FAIL |所有workflow多处`--no-frozen-lockfile`，且CI可自动push lockfile |全workflow frozen + `pnpm install --lockfile-only` consistency check |
| TECH-08 |跨平台checkout行尾稳定 | FAIL |repo缺`.gitattributes`；Windows `core.autocrlf=true`使`pnpm lint`产生87个format errors |`.gitattributes` LF + Windows clean clone lint |

## §11：测试与质量门禁

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| TEST-01 |quality+3OS×Node22/24+package smoke+security | PARTIAL |workflow定义且run成功；install非frozen、checks非required |protected green PR run |
| TEST-02 |parser fixtures≥60 | PARTIAL |约80 parser `it`；不是显式fixture registry且缺target matrix |fixture manifest/count gate |
| TEST-03 |每P0/P1 rule≥6（3+/3-） | UNVERIFIABLE |规则tests总量足够，但不能逐rule证明 |per-rule case metadata gate |
| TEST-04 |每auto-fix≥4含幂等/缺依赖/不改 | PARTIAL |fixer tests与idempotency存在；无per-fixer自动计数 |fixer case registry |
| TEST-05 |workspace≥15含4PM/nested/ignore/symlink | PARTIAL |18个 tests；缺manager-real、manifest/config escape |真实fixtures与boundary matrix |
| TEST-06 |CLI integration≥15 | PASS |integration约34个 `it` |spawned tarball consumer补强 |
| TEST-07 |持续golden corpus，真FP/FN先回归 | PARTIAL |政策存在；无版本化可重放golden corpus |`tests/corpus/` + source/commit/expected findings |
| TEST-08 |parser/rule statement+branch≥90% | FAIL |无coverage provider/config/threshold |Vitest v8 coverage + scoped 90% gates |
| TEST-09 |bug先回归、新rule负例、fix幂等才合并 | PARTIAL |PR模板/贡献文档有文字；无machine gate/branch protection |required consistency checks+review |
| TEST-10 |Windows contributor path可运行 | FAIL |本地测试297中1个因symlink EPERM失败；lint因CRLF失败 |junction/capability-aware symlink test + `.gitattributes` |
| TEST-11 |lint无warning | FAIL |linter-only有22 warnings+2 infos；`lint`未`--error-on-warnings` |零warning CI gate、Biome preset升级 |
| TEST-12 |真实Action integration | FAIL |`action.test.ts`只读YAML字符串；workflow无`uses: ./` |fixture consumer jobs验证success/failure/outputs/summary |

## §12：GitHub Action

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| ACT-01 |`uses: owner/repo@v1`可直接运行 | FAIL |0 tag/release；npm404 |published immutable+floating tags consumer run |
| ACT-02 |inputs target/severity/max-warnings | PARTIAL |inputs定义；直接插入shell导致注入 |Node action argv/env validation + malicious inputs |
| ACT-03 |PR annotation至少file/script/rule | PARTIAL |reporter unit实现；Action未真实运行 |`uses: ./` assertion of annotations |
| ACT-04 |summary含packages/scripts/errors/warnings/top rules | PARTIAL |summary writer存在；未端到端 |`GITHUB_STEP_SUMMARY` assertion |
| ACT-05 |默认不写repo、不自动fix | PARTIAL |Action本身无fix；CI其他PR jobs却以write权限执行PR代码并push |Action diff-empty test；CI取消PR auto-push |
| ACT-06 |与CLI共用同一core/版本 | FAIL |`npx scriptspect@latest`随时间变化，不等于引用Action revision |bundled Node24 action from same build/commit |
| ACT-07 |不依赖网络/npm latest | FAIL |每次调用从npm拉包，且当前不存在 |committed/bundled action artifact |
| ACT-08 |stable major+immutable version tags | FAIL |0 tags |release verified后更新`v0`/`v0.1`；1.x才建立`v1` |

## §13：安全、可信与 AI 协作

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| SEC-01 |不exec/spawn目标scripts | PASS |runtime静态检查符合 |保持security test |
| SEC-02 |不读root外文件，glob canonical root | FAIL |explicit config和manifest symlink可读外部 |open前realpath containment；race-aware tests |
| SEC-03 |symlink无loop/escape | PARTIAL |workspace dir loop/escape防护；file-level缺口 |root/config/workspace manifest fixtures |
| SEC-04 |不泄露env/secrets | PARTIAL |runtime不读取secret；Action input注入可能执行任意调用方内容 |bundled action + secret/annotation escaping tests |
| SEC-05 |仅显式`--fix`写，原子 | FAIL |显式门存在；nested field、TOCTOU、固定tmp、多文件partial write破坏承诺 |safe writer contract与fault injection |
| SEC-06 |最小GHA权限 | FAIL |release workflow全局write/id-token；PR format/docs有contents write并跑PR code |job-level permissions；PR jobs read-only |
| SEC-07 |npm provenance/attestation+Release checksum | FAIL |workflow意图存在，公开产物为0 |registry provenance + downloadable verified checksum |
| SEC-08 |AI非唯一证据，人审+CI | PARTIAL |AI_USAGE/MAINTAINERS政策存在；无保护规则 |required review/checks与audit |
| SEC-09 |供应链动作可复现 | PARTIAL |actions pin SHA；pnpm全局安装/lock漂移、npx latest不稳定 |Corepack/pinned package manager+frozen lock+bundled action |

## §14：文档与仓库可信度

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| DOC-01 |README 5秒说明+一命令+真实输出+support matrix+工具关系 | FAIL |结构有；命令不可运行、输出手写、无真实视觉demo/中文切换 |发布后generated transcript+双语parity |
| DOC-02 |每rule why/bad/good/targets/FP/fix/provenance | PASS |26个generated docs齐全 |semantic review + URL check |
| DOC-03 |尊重、事实型comparison | PARTIAL |语气合适；无同corpus head-to-head，若干已完成claim不实 |reproducible comparison report |
| DOC-04 |CONTRIBUTING远程路径+rule checklist | PASS |文件符合 |贡献者dry-run |
| DOC-05 |SECURITY报告/supported versions/no secrets | PARTIAL |模板存在；“latest release”尚不存在 |v0.1后version matrix |
| DOC-06 |MAINTAINERS责任 | PARTIAL |责任写明；声称每release有npm/checksum与事实冲突 |改future tense或发布后证实 |
| DOC-07 |AI_USAGE | PASS |政策内容存在 |实际review enforcement |
| DOC-08 |CHANGELOG/release notes记录语义/FP/breaking | FAIL |0.1.0 changelog先写但未发布，分类不完整 |真实tag/release notes + categories |
| DOC-09 |monthly evidence且不提交未核验指标 | PARTIAL |政策与单次corpus报告存在；无scheduled workflow/月表 |read-only draft artifact+human-reviewed monthly PR |
| DOC-10 |README中英双版可切换 | FAIL |仅英文README |`README.md` + `README.zh-CN.md`完整parity互链 |
| DOC-11 |首页真实before/output/fix/Action示例 | FAIL |只有文本mock和不可用Action snippet |deterministic fixture生成SVG/transcript/patch/annotation |
| DOC-12 |FAQ/排错/完整docs入口 | FAIL |无FAQ和docs landing |双语FAQ、support matrix、docs navigation |
| DOC-13 |所有status/metrics可点击核验 | FAIL |README称M0–M8 merged/CI green，release/adoption却未完成 |只呈现当前可验证状态及source links |

## §15：里程碑退出条件

| Milestone | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|
| M0 | PARTIAL |repo/license/templates/CI存在；无name gate/PR-only保护证据 |name record+protected buildable main |
| M1 | FAIL |parser/IR和普通负例存在；target-specific quote/escape/operator核心不正确 |target parse matrix全绿 |
| M2 | PARTIAL |26规则与大量tests；部分核心规则truth失败 |per-rule tests+precision corpus |
| M3 | PARTIAL |reporters/explain/docs存在；schema/output契约未发布 |versioned schemas+consumer |
| M4 | FAIL |safety model/dry-run/idempotency基础有；fixer可改错字段 |nested/atomic/boundary/fault tests |
| M5 | FAIL |discovery有；workspace bin truth错误、真实4PM证据不足 |manager fixtures+bin contract+100pk benchmark |
| M6 | FAIL |Action文件/annotations代码有；无可运行tag/consumer |published Action e2e |
| M7 | FAIL |release workflow骨架有；0 tag/release/npm/checksum |OIDC发布链路全程成功且可恢复 |
| M8 | PARTIAL |133 repos/62 reviewed findings报告；未达两周、100样本、head-to-head或外部采用 |完整kill-or-commit证据 |

## §16：14天 Kill-or-Commit 与质量门

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| KOC-D1–6 |repo/竞品/lexer/IR/P0 rules/reporter | PARTIAL |骨架与实现存在；parser truth已否定“准确完成” |修复后的target corpus与CI |
| KOC-D7 |可安装0.0.x preview | FAIL |package/release manifest均0.0.0，npm404 |registry install smoke |
| KOC-D8–9 |只读扫描500–1000 public repos | FAIL |实际133 repos；工具只读 |500–1000版本化样本和artifact |
| KOC-D10 |人工抽样≥100并按rule算precision | FAIL |只审62条 |≥100逐项judgement dataset |
| KOC-D11 |FP先转regression再修 | UNVERIFIABLE |报告为0 FP，无法证明历史流程 |issue→failing fixture→fix链 |
| KOC-D12 |npm/pnpm workspace+真实monorepo | PARTIAL |本地实现；公开corpus root-only |真实外部monorepo report |
| KOC-D13 |Action alpha在自控repo验证 | FAIL |无consumer run/tag/npm |self-consumer或`uses: ./`运行证据 |
| KOC-D14 |发布validation report并签署commit/pivot/kill | PARTIAL |报告存在；没有正式决议且多个gate未达 |maintainer-signed gate decision |
| GATE-precision |overall≥85%、P0 high≥95% | PARTIAL |62/62、P0 28/28；样本不足且新发现漏报未计入 |≥100独立复核、含FN corpus |
| GATE-coverage |≥10项目、≥20真实问题、≥4规则类 | PASS |报告称68 repos/534 findings/14 rules |保留raw artifact/hash |
| GATE-competition |同fixture corpus胜过scripts-doctor且不靠FP | FAIL |报告明确不是head-to-head |固定版本/命令/outputs/adjudication |
| GATE-interest |≥5独立试用或≥3非熟人反馈 | FAIL |0外部issues/adopters证据 |公开、非自造feedback links |
| GATE-onboarding |首次scan<10min，理想<2min | FAIL |包不可安装，无计时测试 |fresh-user timed log/recording |

## §17–§18：Issue 组织与真实 adoption

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| ISSUE-01 |M0–M8任务有独立issue、依赖和验收 | PARTIAL |issue templates存在；里程碑证据主要是PR编号 |完整issue→PR→DoD links |
| ADOPT-01 |README用mac正常/Windows失败/PR拦截before-after | FAIL |无真实before/after与annotation演示 |可复现fixture+generated demo |
| ADOPT-02 |首页真实一条命令输出，不以架构图代替 | FAIL |文本是手写且当前版本不可从npm运行 |CI生成transcript/SVG与text fallback |
| ADOPT-03 |公开repo统计仅在真实scan后发布 | PARTIAL |有run/report；root-only限制不能泛化ecosystem |样本/方法/version/hash完整公开 |
| ADOPT-04 |provenance只引用可核验事实，不批量@维护者 | PARTIAL |规则source links存在；外部互动不可完全验证 |outreach audit log |
| ADOPT-05 |cross-env/rimraf/shx是修复工具非竞争对象 | PASS |README关系说明正确 |保持文档测试 |
| GROWTH-01 |不买/换star、不造假downstream、不自动群发issue | UNVERIFIABLE |corpus自动化只读；无法证明所有人工行为 |API activity ledger/approval links |
| GROWTH-02 |不宣称“行业标准/最完整” | PASS |当前无此类措辞 |文档review gate |
| GROWTH-03 |首页不以grant申请为卖点 | PASS |当前README符合 |保持scope |

## §19–§21：KPI、证据与申请对齐

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| KPI-priority |downstream/CI > contributor/issues > downloads > stars | PARTIAL |evidence政策列指标；没有scorecard/决策机制 |月度scorecard按优先级呈现 |
| KPI-30d |v0.1、20–30 rules、Action、20 adopters等 | FAIL |26 rules存在；0 release/package/adopter/external contributor |期限到达时的API ledger |
| KPI-60/90/180 |递进adoption/维护/release指标 | TIME-BOUND |repo刚创建，尚未到窗口 |对应月份ledger |
| KPI-readiness |公式与<70/70–80/80+决策 | FAIL |无计算/记录 |versioned scorecard+source links |
| EVID-01 |每月从GitHub/npm API生成draft，人工核验后提交 | FAIL |仅政策，无monthly workflow |scheduled read-only artifact+reviewed PR |
| EVID-02 |记录adoption/community/maintenance/quality/impact/AI leverage | PARTIAL |六类字段已定义；无月度数据 |`docs/evidence/YYYY-MM.md` |
| APPLY-01 |meaningful usage/adoption/ecosystem/maintenance | FAIL |release/adoption事实不足 |≥6个月公开记录 |
| APPLY-02 |公开证明primary maintainer的commit/review/release | PARTIAL |MAINTAINERS指定；无release/持续时间 |release/review/triage history |
| APPLY-03 |公开证明非自造downstream | FAIL |0可核验consumer |registry/GitHub code search/consumer links |
| APPLY-04 |公开证明bug/rules/PR/release/security/contributor维护 | PARTIAL |规则/CI/治理有；release/外部贡献没有 |changelog+issue/PR/release ledger |
| APPLY-05 |Codex用途与人审/CI价值可说明 | PARTIAL |AI_USAGE政策有；无量化/实例ledger |AI leverage evidence |
| APPLY-06 |申请模板仅在数字真实后填 | PASS |没有伪造申请指标文本 |未来逐项source-link review |

## §22：失败预案

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| RISK-win |定位cross-shell/cross-platform，不只Windows | PASS |README三平台定位 |保持 |
| RISK-fp |parser优先、分级、FP→fixture | PARTIAL |模型/政策存在；当前parser仍有FN/FP且样本不足 |target corpus+issue chain |
| RISK-remedy |发现/CI gate，不替代cross-env/shx | PASS |文档关系正确 |保持 |
| RISK-importance |靠Action/downstream/monorepo/provenance/维护负担 | FAIL |功能骨架有，公开依赖事实没有 |real consumers/releases/contributions |
| RISK-stars |不把stars当成功，优先真实使用 | PARTIAL |政策正确；没有usage追踪 |monthly adoption ledger |

## §23：Definition of Done

| ID | 要求 | 状态 | 当前证据/缺口 | 核签证据 |
|---|---|---|---|---|
| DOD-01 |新代码经GHA而非本地作为最终验收 | PARTIAL |main CI曾green；required checks缺失 |最终PR全部GHA checks |
| DOD-02 |不在用户本地开发 | UNVERIFIABLE |附件历史流程要求不能由tree证明；本轮不受其控制 |remote audit trail |
| DOD-03 |每新rule metadata+正负fixtures+docs | PARTIAL |metadata/docs有；per-rule fixture数量不可核验 |consistency/count gate |
| DOD-04 |每bug先regression | UNVERIFIABLE |政策有；时间顺序无法从main证明 |PR timeline/failing-first evidence |
| DOD-05 |自动fix有幂等与safety | FAIL |普通test有；nested/scripts与写边界P0否定安全完成 |hostile/fault/concurrency suite |
| DOD-06 |README示例与实际CLI一致 | FAIL |手写输出、`--no-color`实际不符、npm不可用 |generated transcript snapshot |
| DOD-07 |JSON输出变更有schema/version评估 | PARTIAL |`schemaVersion`存在；无发布output schema/gate |formal schema + compatibility CI |
| DOD-08 |dependency/action变更经供应链检查 | PARTIAL |pin/Dependabot/dependency review存在；lock/npx不稳定 |frozen/provenance/SBOM或policy evidence |
| DOD-09 |PR说明risk/tests/semantics/rollback | PARTIAL |模板存在；无required enforcement |PR audit+review |
| DOD-10 |不虚构adoption/benchmark/比例/反馈 | PARTIAL |corpus披露限制；README M0–M8 claim过度 |纠正claim、保存raw evidence |
| DOD-11 |第三方写操作有授权 | UNVERIFIABLE |自动化只读；全历史不可证 |activity+approval ledger |
| DOD-12 |新竞品出现先更新研究/比较 | PARTIAL |有dated comparison；无复核cadence |quarterly issue/report |
| DOD-13 |最终逐门核签报告 | FAIL |不存在；本文件是pre-fix baseline，不是完成报告 |修复后用同矩阵逐项附证据，所有required项PASS |

## 当前发布与 GitHub 状态（审计时）

- `main`: `d0650a7e232f720badec6f6be806c13f8e2fa25c`
- PR #62：OPEN、MERGEABLE/UNSTABLE、无checks；不可在修复前合并。
- Git tags：0。
- GitHub Releases：0。
- npm `scriptspect`：404。
- branch protection/rulesets：无。
- README Action示例引用不存在的`@v0.1`。
- `package.json`与release manifest版本：`0.0.0`。

## 关闭审计所需的最终证据包

1. 修复PR逐批审阅记录；所有required checks在Linux/macOS/Windows和Node 22/24通过。
2. parser per-target golden matrix、≥90% parser/rule coverage、每rule/每fixer可计数门禁。
3. hostile config/manifest/symlink/fixer/Action-input安全测试。
4. `npm pack`内容清单（含schema、中英README、bundled Action）及fresh consumer smoke。
5. `uses: ./`与发布tag Action consumer的annotations/summary/exit-code证据。
6. GitHub Release资产、`SHA256SUMS`、registry tarball一致性、npm provenance/attestation。
7. `v0.1.0` immutable tag及verified后更新的`v0`/`v0.1` aliases；不创建误导性的`v1`直到1.x。
8. 双语README parity、由fixture生成的真实演示、FAQ与完整docs landing。
9. ≥100人工样本、真实workspace corpus、同语料scripts-doctor对比及明确限制。
10. 发布后的真实onboarding/外部interest证据；不得自造或自动写第三方仓库。
11. 基于本矩阵的最终§23 DoD报告，未能公开证明的运营/KPI项保持未完成，不得用代码替代事实。

## 后续状态（追加，不改写基线）：v0.1 hardening 实现后

- 追加日期：2026-09-01
- 本次后续审计所验证的实现 HEAD：`feat/v0.1-hardening` at `dde44ea0e3459a2fe770a1701eb3bbc6146321a7`
- README/status 固定的已审阅 runtime/release source：`13dfcfcec3f50c3dd786a1f9b2a4225391ded0e5`
- 逐门核签：[v0.1 Definition of Done 核签账本](v0.1-dod-2026-09-01.md)

本节是 append-only 的后续审计。上文的 212 项基线、`73 FAIL / 90 PARTIAL / 36 PASS / 12 UNVERIFIABLE / 1 TIME-BOUND` 和当时远程状态都保留为修复前历史，不被回填或伪装成当时已经通过。本节只说明当前 hardening 分支关闭了哪些仓库内缺陷，以及哪些 hosted、管理员、公开发布与外部门禁仍然未完成。

### 后续总体状态

| 范围 | 状态 | 后续事实 |
|---|---|---|
| Parser、rules、配置、schema、root/workspace 边界 | `LOCAL PASS` | target-aware parse matrix、PS050/PS051、严格 JSON/config、canonical containment、真实 bin visibility 与生成式 schema parity 已实现并有回归。 |
| Fixer 原子性、安全与恢复 | `LOCAL PASS` | 根 `scripts` 定位、dependency gate、事务 journal、race/hardlink/inode 防护、fault recovery、rollback、manual recovery 与幂等测试已实现。 |
| CLI、package 与 bundled Action | `LOCAL PASS` | no-color/exit semantics、包内容、Node 24 Action bundle、严格 inputs、numeric outputs、annotations/summary 与只读行为已有本地消费测试。 |
| 双语首页与公开 claims | `LOCAL PASS` | 中英双向切换、单 fixture 生成 before/output/patch/after、FAQ/docs 入口与 pre-release 状态机已实现；不展示不存在的 npm/Action 命令。 |
| CI/release workflow 源码契约 | `LOCAL PASS` | frozen installs、full-SHA Actions、read-only PR policy、真实 `uses: ./` job、无环境权限的 intent discovery、single candidate、四资产 draft、durable-state 后的 exact-tag dispatch、OIDC provenance、source-bound comparator、registry backoff、双 write-ahead state 与 alias/final evidence recovery 均有 policy/state-machine tests。普通 main commit 不再申请发布环境。 |
| 最终 GitHub-hosted 验收 | `HOSTED PENDING` | [PR #65](https://github.com/Tom409114/scriptspect/pull/65) 的 run `33445555803` 已通过三系统 Node 22/24、coverage、dependency review、CodeQL、生成物、锁文件、打包消费与 benchmark，并实际生成及上传 summary artifact；Action consumer 唯一失败是证据脚本写成 `in`，而 reporter 的确定文案是 `across`。实现 HEAD 已修正并用 workflow regression 固定精确文案，仍需准确新候选的完整全绿证据。 |
| Branch/tag/environment 配置 | `ADMIN OPEN` | main/tag rulesets、required checks、`npm-bootstrap`/`release` environments、审批与 coordinator actor 需管理员操作。 |
| npm 与 GitHub 正式发布 | `PUBLICATION OPEN` | bootstrap ownership/integrity contract、OIDC、`v0.1.0`、Release assets、checksum、registry provenance、`v0.1`/`v0` aliases 尚未用公开产物验证。 |
| Corpus precision、competition、onboarding、adoption、KPI | `EXTERNAL OPEN` | 自动化工具和 draft schema 已具备；≥100 人工裁决、独立反馈/下游、计时和时间型指标不能由代码生成，也没有被声明为完成。 |

### 已关闭的高风险缺陷簇

1. 原共享 lexer/IR 混合 POSIX 与 cmd 语义的问题，已替换为 target-local parsing、raw span、wrapper exact-slice 与 parse diagnostics。
2. explicit config、workspace manifest 与 symlink 逃逸，unknown/duplicate config/manifest 输入和虚假 workspace bins，已加入 canonical boundary 与严格验证。
3. fixer 误改 nested `scripts`、未验证依赖、固定临时文件、TOCTOU 与多文件 partial write，已改为 root-aware 且可恢复的两阶段 transaction。
4. 原 Action 依赖 `npx @latest` 且从未执行，已改为同 revision 的 self-contained Node 24 bundle，并在 CI 源码中加入真实 `uses: ./` consumer。
5. 原 schema 不随包发布、runtime/schema 漂移，已改为唯一生成式 `schema/config.schema.json` 与 `schema/output.schema.json` 契约。
6. 原 release 流程在 publish 后才做脆弱 checksum 比较、失败会跳过资产且 alias 不存在，已拆为候选 coordinator 与 exact-tag publisher。新流程在 durable staged state 后显式 dispatch，发布前锚定四个资产，按评审的 exact/canonical 模式验证 registry，并用 comparator executable-source digest、`alias-planned`/`final-planned`、全局 publisher/per-SHA state locks、Latest 单调决策与精确 asset/tag CAS rollback 支撑安全恢复。
7. 原首页只有英文、手写 demo 和不存在的 `@v0.1`，已改为中英 parity、可复现生成式演示与明确 pre-release source evaluation。

### 保持未完成的门禁

- 旧 PR #62 不应直接合并；已由 [PR #65](https://github.com/Tom409114/scriptspect/pull/65) 取代，后者仍须在准确候选 SHA 上完成 hosted checks 与审阅。
- `main` 与 version/floating tags 的 rulesets、required checks、environment approvals 和 tag permission drill 仍需管理员配置并记录 ID。不可变版本 tag 必须 no-force/no-delete；floating aliases 只为 coordinator 开放单调 CAS 更新，以及首次创建后失败时恢复到“不存在”的窄 CAS 删除路径。
- npm 首次认领必须先通过 `npm-bootstrap.yml` 发布独立 `0.0.0-bootstrap.N`、验证 `latest` 未移动并提交完整性契约；随后撤销 granular token。
- npm Trusted Publisher 的准确绑定已改为：`Tom409114/scriptspect`、workflow `npm-publish.yml`、environment `release`、allowed action `npm publish`。旧的 `release.yml` 绑定建议已经过时，因为 steady-state OIDC 必须绑定实际执行 publish 的 exact-tag workflow。
- 在 npm provenance、Release assets/checksum、immutable `v0.1.0` 和 tagged Action consumer 全部通过前，不更新 `v0.1`/`v0`，也不创建 `v1`。
- comparison harness 已固定 `scripts-doctor@1.0.0` 并捕获同 fixture outputs，但人工 adjudication 尚未完成，不能宣称胜出。
- corpus workflow 默认选择 100 个 immutable commits，也可由人工请求 1–1,000 个；它生成的 100-finding draft 不等于人工 precision 证明，也不等于真实 adoption。
- 外部 issue/反馈、首次用户 onboarding、downstream、downloads、stars 和 30/60/90/180 天 KPI 均保持真实、可核验但未完成。

### 后续审计结论

仓库内可修复的 correctness、安全、Action、schema、release recovery 与首页缺陷已经从基线的失败形态升级为有本地测试支撑的候选实现。由于 hosted、管理员、公开发布和外部证据仍有明确缺口，项目当前结论仍是 **NOT RELEASE READY**，而不是“全部 DoD PASS”。最终状态只应在[逐门核签账本](v0.1-dod-2026-09-01.md)列出的真实证据产生后更新。

## 远程落地审计（2026-09-01，追加）

本节是 append-only 的远程落地审计，只记录 2026-09-01 再核验时的 GitHub 与 npm 权威状态；不回写上文 212 项修复前基线，也不篡改前一节 hardening re-audit 的历史判断。远程工程、CI 与部分管理员控制已经闭合，但公开发布、floating alias 权限和 M8 外部/时间证据仍保持 OPEN。

### 已闭合的远程工程与管理员项

| 项目 | 状态 | 远程证据 |
|---|---|---|
| 远程审计基线 `main` | `CLOSED` | 本次核验时 `main` 为 [`4d34f86827dbb7a13b1300e317083aae64002ef2`](https://github.com/Tom409114/scriptspect/commit/4d34f86827dbb7a13b1300e317083aae64002ef2)；[PR #65](https://github.com/Tom409114/scriptspect/pull/65)、[#67](https://github.com/Tom409114/scriptspect/pull/67)、[#68](https://github.com/Tom409114/scriptspect/pull/68) 与 [#69](https://github.com/Tom409114/scriptspect/pull/69) 均已 merged。后续仅文档合入可使 `main` SHA 前进，不改变这条审计证据。 |
| `main` hosted CI | `CLOSED` | push run [`33447746364`](https://github.com/Tom409114/scriptspect/actions/runs/33447746364) 在上述 exact `main` SHA 上 completed/success。 |
| `main` 保护 | `CLOSED` | active branch ruleset [`21964571`](https://github.com/Tom409114/scriptspect/rules/21964571) 保护默认分支：要求 pull request、严格 required status checks、linear history，并禁止 deletion 与 non-fast-forward。 |
| immutable version tag 保护 | `CLOSED（配置）` | active tag ruleset [`21964642`](https://github.com/Tom409114/scriptspect/rules/21964642) 匹配 `refs/tags/v*.*.*`，阻止 update 与 deletion。当前尚无正式 tag，因此这里只核签规则已落地，不把它表述为发布已完成。 |
| environments 与 variables | `CLOSED（配置）` | `npm-bootstrap` 与 `release` environments 已创建并设置 required reviewer/branch policy；仓库变量为 `NPM_BOOTSTRAP_ENABLED=false`、`NPM_TRUSTED_PUBLISHING_READY=false`、`RELEASE_PR_ACTORS=github-actions[bot]`、`RELEASE_PR_CI_MODE=manual-approval`。两个 `false` 是正确的关闭态，不代表 npm bootstrap 或 Trusted Publisher 已完成。 |
| workflow 供应链 | `CLOSED` | 当前所有第三方 GitHub Actions `uses:` 均固定到完整 commit SHA；本仓库内 Action 继续使用同 revision 的 `./`。 |
| Dependabot | `CLOSED` | PR #68 将解析版本统一到 `esbuild 0.28.2`，已高于 advisory 的 first-patched `0.28.1`；原 low-severity alert #1 已 fixed，本次核验时 open Dependabot alerts 为 0。 |

### 仍然 OPEN 的发布与外部证据项

| 项目 | 状态 | 当前事实与关闭条件 |
|---|---|---|
| release PR | `OPEN` | 本次核验时 [PR #66](https://github.com/Tom409114/scriptspect/pull/66) 为 OPEN；head 为 `39a464752b1321464b474aa42682fddde5df7ea5`，mergeable state 为 `CLEAN`。其 CI run [`33447786827`](https://github.com/Tom409114/scriptspect/actions/runs/33447786827) 已 completed/success，16/16 jobs success；这关闭该快照的候选 CI 门禁，但不等于 PR 已合并或 release 已发布。后续 `main` 更新会让 release-please 刷新 head，届时必须以新 head 的 CI 为准。 |
| npm package 与公开产物 | `PUBLICATION OPEN` | `npm view scriptspect` 仍返回 `E404`；Git tags 为 0，GitHub Releases 为 0。不存在 `scriptspect@0.1.0`、provenance、Release assets/checksum 或可消费的 released Action reference。 |
| bootstrap contract / Trusted Publisher | `ADMIN + PUBLICATION OPEN` | 首次认领的独立 bootstrap 版本、`latest` 不移动证明、registry integrity contract、短期 token 撤销记录和 npm 侧 Trusted Publisher 配置尚未产生。准确 Trusted Publisher tuple 是 repository `Tom409114/scriptspect`、workflow **`npm-publish.yml`**、environment **`release`**、allowed action `npm publish`；不是 `release.yml`。只有配置完成并经真实 OIDC publish 验证后，才可把 `NPM_TRUSTED_PUBLISHING_READY` 设为 `true`。 |
| floating aliases | `ADMIN OPEN` | ruleset `21964642` 只关闭 immutable `v*.*.*` 的 update/delete；当前没有 `v0`/`v0.*` floating policy 或 coordinator bypass actor。必须先落实并演练仅允许 coordinator 单调 CAS create/update、以及“此前不存在且同一发布失败”时窄范围 CAS delete 的权限路径，不能假设默认 `GITHUB_TOKEN` 可绕过 ruleset。 |
| M8 / 外部与时间证据 | `EXTERNAL + TIME OPEN` | ≥100 条人工裁决与二次复核、同语料 scripts-doctor adjudication、两周窗口、独立试用/反馈、首次 onboarding 计时、真实 downstream，以及 30/60/90/180 天 KPI 仍需真实用户与时间产生；merged PR、green CI 和管理员配置不能替代这些证据。 |

### 远程落地结论

截至本次核验，hardening、修复 PR、准确 `main` hosted CI、主分支保护、immutable version tag update/delete 保护、environments/variables、Action SHA pinning 与 Dependabot 修复均已有远程落地证据；PR #66 也有准确 head 上 16/16 全绿且 CLEAN 的候选证据。但 npm 仍为 E404、tag/release 均为 0，bootstrap/Trusted Publisher、floating alias coordinator bypass 与 M8 外部/时间证据仍未关闭。因此当前判定仍是 **NOT RELEASE READY**，不得表述为“v0.1 已发布”“全部 DoD PASS”或“M0–M8 已完成”。

## 最终首页与安全审计补充（2026-09-01，追加）

本节继续采用 append-only 方式，不回写前述修复前基线或早期远程快照。它记录在首页/发布证据升级与 CodeQL 跟进合并后的最新实现证据，并明确 release-please PR 后续前进造成的状态变化。

### 新增闭合项

| 项目 | 状态 | 权威证据 |
|---|---|---|
| 双语 GitHub 首页 | `CLOSED` | [PR #78](https://github.com/Tom409114/scriptspect/pull/78) 合并响应式品牌 hero、中英切换、真实 before/result/patch/after、托管 Action annotations/summary 证据，以及 honest pre-release/released 状态渲染。README 不展示不存在的 npm quick start 或 Action tag。 |
| npm 包内 README 与 schema | `SOURCE CLOSED / PUBLICATION OPEN` | PR #78 通过隔离 staging 生成英文与中文 package README，并在候选 tarball 中验证 package/version/repository、两份 schema、Action bundle 与 published-state 文案；真实 registry/unpkg 消费仍需首次发布后验证。 |
| 发布证据与凭据隔离 | `SOURCE CLOSED / ADMIN OPEN` | PR #78 加入 fail-closed release receipt/remote verifier，并把 bootstrap 拆为无 secret prepare、fresh publisher 与 public verify 三个隔离 jobs；唯一 token step 不 checkout 或执行候选源码。npm ownership、OIDC 与真实 provenance 仍未发生。 |
| CodeQL 与漏洞入口 | `CLOSED` | [PR #79](https://github.com/Tom409114/scriptspect/pull/79) 修复 scoped package purl 的不完整编码；准确 `main` run [`33476006926`](https://github.com/Tom409114/scriptspect/actions/runs/33476006926) 的 CodeQL job success，`refs/heads/main` 当前无 open code-scanning alerts，Private vulnerability reporting 已启用。 |
| 最新实现快照 | `CLOSED` | PR #78 合并为 `e98b418db1d7d7dfd897a489e1fe7f295b46f206`，PR #79 合并为 `50d02d44abdbfb3489516f39f4251481dfec1548`；远端与本地 `main` 在核验时一致，准确 SHA 的 push CI completed/success。 |

### 当前 release PR 与外部边界

- [PR #66](https://github.com/Tom409114/scriptspect/pull/66) 仍为 OPEN/BLOCKED；核验时 base 为 `50d02d44abdbfb3489516f39f4251481dfec1548`，head 为 `390d7ccd61c79bedee182557bf4b6dc2bfbc7376`。其最新 run [`33476042317`](https://github.com/Tom409114/scriptspect/actions/runs/33476042317) 为 `action_required` 且没有 jobs，符合 `RELEASE_PR_CI_MODE=manual-approval` 的人工门控；旧 head 的绿色运行不能冒充当前候选证据。
- 仓库变量保持安全关闭：`NPM_BOOTSTRAP_ENABLED=false`、`NPM_TRUSTED_PUBLISHING_READY=false`、`RELEASE_TAG_POLICY_READY=false`、`RELEASE_PR_CI_MODE=manual-approval`、`RELEASE_PR_ACTORS=github-actions[bot]`。
- npm registry 仍为 404，仓库仍为 0 tags / 0 releases。没有真实 `v0.1.0`、`v0.1`/`v0` alias、npm provenance、checksum assets 或 fresh released Action consumer。
- semantic-version tag ruleset 仍只禁止已存在的 `v*.*.*` update/deletion；tag creation actor 与 floating `v0`/`v0.*` 单调更新 policy 仍为管理员门。
- M8 的 ≥100 人工裁决、shared-corpus comparison、独立试用/反馈、首次 onboarding、真实 downstream 与时间型 KPI 仍为 `EXTERNAL + TIME OPEN`，不能由代码、README 或绿色 CI 代替。

### 当前判定

在 PR #78/#79 快照形成时，已知的仓库内高/中优先级项均已闭合；随后更深一轮终审又发现 workspace glob 在 containment 前枚举，以及 corpus resolver 被硬限制为 100 的两个缺口。下节记录其候选修复，避免把旧快照误写成对后续发现的预证明。总体仍是 **NOT RELEASE READY**，因为当前 release PR 尚未通过人工 workflow approval/准确 head CI，且 npm/tag/release 与 M8 真实外部证据尚未产生。

## 最后终审候选补充（2026-09-01，待 hosted 合并证据）

| 项目 | 候选状态 | 当前证据与边界 |
|---|---|---|
| workspace glob 枚举边界 | `LOCAL PASS / HOSTED PENDING` | npm/pnpm glob 在调用 `fast-glob` 前 fail closed；拒绝 parent traversal、POSIX absolute、Windows drive/UNC、negation 与 brace/extglob 隐藏分支，同时保留合法 nested/brace/negation。Action 的向上 root discovery 也被限制在 `GITHUB_WORKSPACE`，CLI 语义不变。 |
| 500–1,000 public-repository 能力 | `LOCAL PASS / HOSTED PENDING` | corpus collector/resolver/scanner 支持 1–1,000，默认仍为 100；新 v2 snapshot 保存逐页哈希、请求与 rate-limit evidence，并兼容 v1 replay。真实只读 API probe 证明 page 10 可读、page 11 按 GitHub ceiling 返回 422；这不冒充一次已经完成的 1,000-repository hosted scan。 |
| 月度 evidence draft | `SOURCE PASS / REVIEWED RUN OPEN` | 新 workflow 仅以 read 权限访问 GitHub/npm 公共 API并上传 artifact，不 commit；404、分页、transport/JSON failure 都保留为 `missing/partial + null`。本地真实 smoke 对当前 npm 404 得到 missing/null；真实 hosted artifact 与人工 reviewer approval 尚未发生。 |
| 组合回归 | `LOCAL PASS / HOSTED PENDING` | 稳定共享树上 69 个 test files：`1,074 passed / 8 skipped`；90% parser/rule coverage floor、typecheck、改动文件 Biome、Actionlint、README parity、生成物与 diff check 均通过。PR 与准确 merge-SHA 的 GitHub-hosted checks 仍需随后产生。 |

该候选关闭了本轮新发现的仓库可修高/中项，但在其 PR 和准确 `main` SHA 的 hosted checks 成功前，不得把 `LOCAL PASS` 提升为 `HOSTED PASS`。M8 的 ≥100 人工裁决、shared-corpus adjudication、真实外部兴趣/onboarding/downstream 与时间型 KPI 继续保持 `EXTERNAL + TIME OPEN`。
