# Live LLM benchmark on Grafana: Claude Code, spec-nav and workflow frameworks / Benchmark LLM thật / 真实 LLM 基准测试

**[English](#english) · [Tiếng Việt](#tiếng-việt) · [简体中文](#简体中文)**

## English

**Status: interim — 8 tasks, recorded 2026-10-14 to 2026-10-15. This report will be updated as more tasks and repeats are run.**

> **What "+ spec-nav" means here.** It is **not the MCP alone**. It is the spec-nav MCP **plus** instructions in `AGENTS.md`/`CLAUDE.md` **plus** a Claude Code hook that **forces** the agent to use spec-nav: it blocks the first code edit until a set of spec-nav tools has been called, and on later tasks it blocks recursive grep. **The MCP alone (installed, no forced calls) has not been measured yet.** These results therefore do not show that Claude Code does better without the MCP: they compare plain Claude Code with a setup that makes spec-nav calls mandatory. Part of the extra cost and tool calls comes from the forced calls.

### Setup

- **Tasks:** 8 merged Grafana pull requests (125681, 129471, 129554, 131434, 131474, 132188, 132784, 133470). Each session starts from the commit before the PR. The agent gets a task written from the issue, not the diff. Every task touches at least two areas of the codebase; 2 of them touch both Go and TypeScript.
- **Oracle:** the PR's own tests, hidden from the agent (`resolved`), plus `go vet`/tests/jest of the packages the PR touches (`no regression`).
- **Agent:** Claude Code, model Claude Sonnet 5.5, 60-minute limit per session.
- **Two setups compared here:**
  - **Claude Code** — no MCP.
  - **Claude Code + spec-nav** — spec-nav MCP, a spec-nav section in `AGENTS.md`/`CLAUDE.md`, and a Claude Code hook. The hook and the instructions changed during the run (tasks in the order they were run):
    - tasks 1–4 (125681, 131434, 133470, 129554), *require*: before the first code edit the agent must have called services, map, find_functions, functions, read_function and callers, and similar_functions before adding a function; grep is allowed.
    - task 5 (132188), *steer*: no edit gate; recursive grep over code is blocked and pointed to spec-nav.
    - tasks 6–8 (131474, 132784, 129471), *light*: before the first edit, map + find_functions + callers and at least 7 spec-nav calls in total; recursive grep is blocked.
- **Simulated user:** Claude Sonnet 5.5. It sees the reference diff and answers the agent's follow-up questions without revealing identifiers; no leak was detected.
- **Code judge:** Claude Sonnet 5.5, blind (shuffled labels), one sample per task. It sees the reference diff (first 20,000 characters), each setup's diff (first 15,000 characters) and whether its hidden tests passed, and scores 1–10.
- **Cost:** agent only, list-price equivalent; the simulated user is excluded.
- One run per (task, setup). 95% intervals: paired bootstrap over tasks.

Three more setups with workflow frameworks (Compass, and ai-wf-bex) ran on the same tasks; see [Workflow frameworks](#workflow-frameworks).

### Results (n = 8, after the corrections listed below)

| Metric (mean per session) | Claude Code | + spec-nav (MCP + instructions + forcing hook) | Difference [95% CI] |
|---|---:|---:|---:|
| Hidden tests pass | 100% (raw 88%) | 100% | 0 |
| Pass and no regression | 88% (raw 75%) | 75% (88%†) | −13% [−50%, +25%] (0†) |
| Judge: overall (1–10) | 7.8 | 8.1 | +0.4 [−0.5, +1.4] |
| Judge: overall, without task 133470 (n = 7) | — | — | 0.0 [−0.7, +0.9] |
| Judge: correctness | 8.3 | 8.6 | +0.4 [+0.1, +0.8] |
| Judge: completeness | 7.8 | 8.3 | +0.5 [−0.3, +1.4] |
| Judge: reuse of existing code | 7.5 | 7.8 | +0.3 [−0.9, +1.4] |
| Judge: code quality | 7.6 | 8.0 | +0.4 [−0.4, +1.1] |
| PR files the agent also changed (recall) | 90% | 92% | +3% [0%, +8%] |
| Files changed that the PR also changed (precision) | 97% | 97% | 0 |
| **Cost per session** | **$0.34** | **$0.54** | **+$0.20 [+$0.13, +$0.26] (+58%)** |
| Input tokens (incl. cache) | 555k | 906k | +351k [+69k, +601k] |
| Tool calls | 14.5 | 26.5 | +12.0 [+5.6, +17.5] |
| Wall time (min) | 15.6 | 15.9 | +0.4 [−13.1, +16.7] |
| Sessions that hit the time limit | 0 / 8 | 1 / 8 | |

† If the failure on 132188 is counted as flaky (correction 4).

Per task (Claude Code / + spec-nav):

| Task | Pass + no regression | Judge overall | Cost | Tool calls (spec-nav calls) |
|---|:-:|:-:|:-:|:-:|
| 125681 | ✅ / ✅ | 7 / 9 | $0.17 / $0.42 | 11 / 21 (11) |
| 129471 | ❌ / ✅ | 8 / 8 | $0.44 / $0.68 | 15 / 33 (7) |
| 129554 | ✅ / ✅ | 7 / 8 | $0.14 / $0.38 | 6 / 27 (10) |
| 131434 | ✅ / ✅ | 9 / 8 | $0.29 / $0.55 | 15 / 21 (6) |
| 131474 | ✅ / ✅ | 9 / 9 | $0.12 / $0.33 | 7 / 29 (5) |
| 132188 | ✅ / ❌† | 8 / 7 | $0.40 / $0.48 | 17 / 30 (2) |
| 132784 | ✅ / ❌ | 8 / 7 | $0.39 / $0.69 | 21 / 33 (8) |
| 133470 | ✅* / ✅ | 6* / 9 | $0.80 / $0.81 | 24 / 18 (7) |

\* See correction 1. † Most likely flaky, see correction 4.

### Reading

1. **The hidden tests do not separate the setups.** After correction 1, every session passes its PR's tests. This set of tasks is too easy for that oracle to show a difference.
2. **No measurable quality difference.** All judge differences except correctness include zero. On judge overall, spec-nav wins 3 tasks, ties 2 and loses 3. Its +0.4 comes from task 133470, where the judge was told that the Claude Code session failed its hidden tests. Without that task the difference is 0.0. Correctness (+0.4, interval just above zero) is one judge sample on a 1–10 scale; treat it as a hint, not a result.
3. **The clear effect is cost.** The spec-nav setup costs about $0.20 (+58%) more per session, with +63% input tokens and about 1.8× as many tool calls. The sources are the tool definitions sent on every turn, the discovery calls, and the hook, which refuses edits until the required spec-nav calls are made. How much of the extra cost comes from the MCP itself and how much from the forced calls cannot be separated with this run.
4. **Regressions.** spec-nav had two:
   - On 132188 one jest `waitFor` timed out in `hooks.test.ts`, during a 306-second suite run. The spec-nav session's `hooks.ts` is byte-identical to the Claude Code session's (same blob `c197c739914`), and that test passed for Claude Code. This is most likely a flaky test, not the agent's change (correction 4).
   - On 132784 the session hit the 60-minute limit while it was updating existing tests in `apistore/prepare_test.go`; two of those tests fail. Every setup had to edit that file.

   Claude Code had one: on 129471 a failing `BrowseDashboardsPage` test. Counting 132188 as flaky, both setups pass without regression on 7 of 8 tasks.
5. **Judge scores miss omissions.** A manual review of task 125681 found that the spec-nav session (judge: 9/10) missed three places the PR changed, including `SetDefaultPermissionsAfterCreate`: root dashboards would no longer get default Editor/Viewer permissions. The hidden tests do not cover this either.
6. **Compared with the simulated benchmarks.** The simulated agents (deterministic policies) gained a lot from spec-nav, for example reuse 40% → 93% on large immich sessions. This live run does not reproduce that: with Claude Sonnet 5.5 and Grep, the agent already finds about 90% of the PR's files. The simulated baseline is weaker than a real model.
7. Adding spec-nav to a workflow framework showed the same pattern: no measurable quality difference, higher cost (next section).

### Workflow frameworks

Three more setups ran on the same tasks:

- **Compass** — a workflow framework (rules, skills and sub-agents that write a spec before coding). It searches with Grep. 8 tasks.
- **Compass + spec-nav** — the same, with spec-nav wired into Compass and its sub-agents, and the same spec-nav section and hook as above. 8 tasks.
- **ai-wf-bex + spec-nav** — a workflow framework run through its own `/create` command, installed with its own install script, plus its own hook that blocks recursive grep over code. From task 6 on, the light gate described above was added. It only ran on tasks 4–8 (129554, 132188, 131474, 132784, 129471), so n = 5.

| Metric (mean per session) | Claude Code | Compass | + spec-nav (MCP + instructions + forcing hook) | Compass + spec-nav | ai-wf-bex + spec-nav |
|---|---:|---:|---:|---:|---:|
| Tasks | 8 | 8 | 8 | 8 | 5 |
| Hidden tests pass | 100% | 100% | 100% | 100% | 100% |
| Pass and no regression | 88% | 100% | 75% (88%†) | 100% (n = 7) | 60% |
| Judge: overall | 7.8 | 7.6 | 8.1 | 7.6 | 7.8 |
| Judge: reuse | 7.5 | 7.0 | 7.8 | 7.5 | 7.8 |
| PR files changed (recall) | 90% | 94% | 92% | 90% | 94% |
| Changed files in the PR (precision) | 97% | 95% | 97% | 91% | 92% |
| Files changed outside the PR | 0.3 | 0.4 | 0.3 | 0.6 | 0.8 |
| Cost per session | $0.34 | $0.60 (n = 7) | $0.54 | $0.85 | $1.30 |
| Input tokens (incl. cache) | 555k | 1,147k (n = 7) | 906k | 1,873k | 1,402k |
| Tool calls | 14.5 | 22.0 | 26.5 | 32.9 | 57.8 |
| Wall time (min) | 15.6 | 14.4 (n = 7) | 15.9 | 21.2 | 8.1 |
| User prompts | 1.3 | 1.4 | 1.1 | 1.4 | 2.0 |
| Sessions errored or timed out | 0 | 1 | 1 | 0 | 0 |

Paired differences (same tasks):

| Comparison | n | Judge overall | Cost | Other |
|---|---:|---:|---:|---|
| Compass − Claude Code | 7 | −0.1 [−1.0, +1.0] | +$0.27 [−$0.06, +$0.55] | judge reuse −0.5 [−1.3, 0.0] |
| Compass + spec-nav − Compass | 7 | 0.0 [−1.0, +0.9] | +$0.25 [−$0.05, +$0.53] | input tokens +678k [+262k, +1,160k] |
| Compass + spec-nav − spec-nav | 8 | −0.5 [−1.4, +0.1] | +$0.31 [+$0.14, +$0.50] | |
| ai-wf-bex + spec-nav − spec-nav | 5 | 0.0 [−0.8, +0.8] | +$0.79 [+$0.54, +$1.12] | wall time −14.4 min [−26.2, −3.9] |
| ai-wf-bex + spec-nav − Compass + spec-nav | 5 | 0.0 [−0.8, +0.8] | +$0.58 [+$0.22, +$0.96] | wall time −9.1 min [−17.0, −0.6] |
| ai-wf-bex + spec-nav − Claude Code | 5 | −0.2 [−0.8, +0.4] | +$1.00 [+$0.76, +$1.36] | |

Per task, judge overall and pass + no regression (Claude Code / Compass / + spec-nav / Compass + spec-nav / ai-wf-bex + spec-nav):

| Task | Judge overall | Pass + no regression |
|---|:-:|:-:|
| 125681 | 7 / 6 / 9 / 8 / – | ✅ ✅ ✅ ✅ – |
| 129471 | 8 / 8 / 8 / 8 / 7 | ❌ ✅ ✅ ✅ ❌ |
| 129554 | 7 / 8 / 8 / 7 / 8 | ✅ ✅ ✅ ✅ ✅ |
| 131434 | 9 / 7 / 8 / 8 / – | ✅ ✅ ✅ ✅ – |
| 131474 | 9 / 9 / 9 / 9 / 8 | ✅ ✅ ✅ ✅ ✅ |
| 132188 | 8 / 7 / 7 / 7 / 8 | ✅ ✅ ❌† ⏱ ❌ |
| 132784 | 8 / 7 / 7 / 8 / 8 | ✅ ✅ ❌ ✅ ✅ |
| 133470 | 6* / 9 / 9 / 6 / – | ✅* ✅ ✅ ✅ – |

⏱ regression suite timed out (correction 2). \* correction 1. † correction 4.

Reading:

1. **No framework improves quality measurably.** Every judge difference includes zero. The only clear differences are cost and tokens.
2. **Compass + spec-nav** is the only setup with no regression, no error and no timeout, but with n = 7–8 "100% vs 88%" is one task. It changes the most files outside the PR (0.6 per session, precision 91%), and it is the slowest (21 min on average; 59.5 min on 131434).
3. **ai-wf-bex + spec-nav** is the fastest (8.1 min) and the most expensive ($1.30, 57.8 tool calls). It has the most regressions (2 of 5). Both are assertion failures in existing tests of components it changed (`BrowseFolderVariablesPage` on 129471, `FolderRepo` on 132188), not timeouts. It wrote no test files on 3 of its 5 tasks, against 1 of 5 for Claude Code on the same tasks; the judge noted "no tests" on both regressed tasks. Writing and running fewer tests may explain both the speed and the regressions; the transcripts do not record tool inputs, so this is not verified. Every one of its sessions needed a second prompt from the simulated user, which sees the reference diff.
4. **The spec scores cannot be compared.** The frameworks also write a spec, scored by the judge, and the aggregate report shows Compass 6.0 against Compass + spec-nav 7.7, and valid `path:line` citations 9% against 78%. But Compass produced a scored spec on 2 tasks (129471, 132188) and Compass + spec-nav on 3 other tasks (125681, 129554, 133470), never on the same task. That is not a paired comparison, and n is 2 and 3. ai-wf-bex + spec-nav was scored on all 5 of its tasks: spec 7.4, blast-radius coverage 8.4, valid citations 67%.
5. **Sub-agent tool calls are recorded as 0 in every setup, including Compass, which uses sub-agents.** Either they were not used or the harness does not count them; check this before quoting tool-call or cost numbers for Compass.

### Corrections applied

| # | Session | What happened | Adjusted result |
|---|---|---|---|
| 1 | 133470, Claude Code | The hidden Go tests failed to compile: the agent had written its own test with the same function name (`TestDashboardsAPIBuilderMutateNotebook redeclared`). The logic was never tested. | Counted as pass. The judge score (6) is not adjusted; it was given with "hidden tests: FAIL". |
| 2 | 132188, Compass + spec-nav | The regression suite hit its 20-minute limit. | Excluded from "no regression". |
| 3 | 132784, Compass | The session errored; its cost was recorded as $0. | Excluded from cost, tokens and wall time. |
| 4 | 132188, + spec-nav | One jest `waitFor` timed out in `hooks.test.ts`. The changed `hooks.ts` is byte-identical to the Claude Code session's, which passed the same test. | Not applied to the main numbers; shown as †. Most likely flaky. |

### Limitations and planned fixes

- **The MCP alone has not been measured.** Every spec-nav session also had the instructions and the forcing hook. Planned: an arm with the MCP installed and no hook (and one with the instructions but no hook), so the effect of the MCP itself can be read.
- **Run selection on task 125681.** The spec-nav setup ran 5 times on this task while the setup was being tuned; only the last run is kept. The other tasks ran once. Next step: rerun 125681 with the final setup.
- **The setup changed during the benchmark.** The hook and instructions went through three modes (see Setup), and spec-nav exposed 7 tools up to task 7 and 8 from task 8. "+ spec-nav" is therefore not one fixed treatment; with n = 3–4 per mode, the modes cannot be compared with each other.
- **One run per (task, setup).** Agent variance is not measured; differences of one judge point are within it. Planned: at least 3 repeats.
- **Judge.** Same model as the agent, one sample per task. It is told whether the hidden tests passed, which carries harness errors into its scores (correction 1). Diffs are cut at 15,000 characters: in 4 tasks the judge noted it could not see the whole diff.
- **Hidden-test isolation.** Tests the agent writes can collide with the hidden tests (correction 1). Planned: run the hidden tests in isolation.
- **Regression runs.** A timeout counts as a failure, and flaky tests are not rerun (corrections 2 and 4). Several setups run jest suites at the same time, which makes `waitFor` timeouts more likely. Planned: rerun each failure once and raise the jest timeout.
- **Run selection also affected Compass + spec-nav,** which ran 4 times on task 125681; only the last run is kept.
- **The simulated user sees the reference diff.** More follow-up prompts mean more hints (1.3 vs 1.1 prompts per session).
- **Scope.** One model, one repository and 8 tasks: 4 features, 2 bug fixes, 2 refactors.

## Tiếng Việt

**Trạng thái: tạm thời — 8 task, chạy từ 2026-10-14 đến 2026-10-15. Báo cáo sẽ được cập nhật khi chạy thêm task và lần lặp.**

> **"+ spec-nav" ở đây nghĩa là gì.** Đây **không phải chỉ có MCP**. Đây là MCP spec-nav **cộng** hướng dẫn trong `AGENTS.md`/`CLAUDE.md` **cộng** một hook của Claude Code **ép** agent dùng spec-nav: hook chặn lần sửa code đầu tiên cho tới khi đã gọi đủ một bộ tool spec-nav, và ở các task sau còn chặn grep đệ quy. **Cấu hình chỉ cài MCP (không ép gọi) chưa được đo.** Vì vậy kết quả này không cho thấy Claude Code làm tốt hơn khi không có MCP: nó so sánh Claude Code trơn với một cấu hình bắt buộc phải gọi spec-nav. Một phần chi phí và tool call tăng thêm đến từ các lần gọi bị ép.

### Cách đo

- **Task:** 8 pull request Grafana đã merge (125681, 129471, 129554, 131434, 131474, 132188, 132784, 133470). Mỗi session bắt đầu từ commit ngay trước PR. Agent nhận đề viết từ issue, không phải từ diff. Task nào cũng đụng ít nhất hai khu vực trong code; 2 task đụng cả Go lẫn TypeScript.
- **Oracle:** chính test của PR, agent không được thấy (`resolved`), cùng `go vet`/test/jest của các package mà PR đụng tới (`không hồi quy`).
- **Agent:** Claude Code, model Claude Sonnet 5.5, giới hạn 60 phút mỗi session.
- **Hai cấu hình so sánh trong báo cáo này:**
  - **Claude Code** — không có MCP.
  - **Claude Code + spec-nav** — MCP spec-nav, một mục spec-nav trong `AGENTS.md`/`CLAUDE.md`, và một hook của Claude Code. Hook và hướng dẫn thay đổi trong quá trình chạy (task theo thứ tự đã chạy):
    - task 1–4 (125681, 131434, 133470, 129554), *require*: trước lần sửa code đầu, agent phải đã gọi services, map, find_functions, functions, read_function và callers, và gọi similar_functions trước khi thêm hàm; vẫn được grep.
    - task 5 (132188), *steer*: không có cổng chặn sửa; chặn grep đệ quy vào code và chỉ sang spec-nav.
    - task 6–8 (131474, 132784, 129471), *light*: trước lần sửa đầu, phải đã gọi map + find_functions + callers và tổng cộng ít nhất 7 lần spec-nav; chặn grep đệ quy.
- **User giả lập:** Claude Sonnet 5.5. Nó thấy diff tham khảo và trả lời câu hỏi của agent mà không lộ định danh; không phát hiện lần lộ nào.
- **Judge chấm code:** Claude Sonnet 5.5, chấm mù (nhãn xáo trộn), một lần chấm mỗi task. Judge thấy diff tham khảo (20.000 ký tự đầu), diff của từng cấu hình (15.000 ký tự đầu) và việc test ẩn pass hay fail, rồi cho điểm 1–10.
- **Chi phí:** chỉ tính agent, quy đổi theo giá niêm yết; không tính user giả lập.
- Mỗi cặp (task, cấu hình) chạy một lần. Khoảng tin cậy 95%: bootstrap theo cặp trên các task.

Ba cấu hình nữa với workflow framework (Compass, và ai-wf-bex) chạy trên cùng các task; xem [Workflow framework](#workflow-framework).

### Kết quả (n = 8, sau các hiệu chỉnh liệt kê bên dưới)

| Chỉ số (trung bình mỗi session) | Claude Code | + spec-nav (MCP + hướng dẫn + hook ép dùng) | Chênh lệch [KTC 95%] |
|---|---:|---:|---:|
| Pass test ẩn | 100% (thô 88%) | 100% | 0 |
| Pass và không hồi quy | 88% (thô 75%) | 75% (88%†) | −13% [−50%, +25%] (0†) |
| Judge: tổng thể (1–10) | 7,8 | 8,1 | +0,4 [−0,5, +1,4] |
| Judge: tổng thể, bỏ task 133470 (n = 7) | — | — | 0,0 [−0,7, +0,9] |
| Judge: đúng | 8,3 | 8,6 | +0,4 [+0,1, +0,8] |
| Judge: đủ | 7,8 | 8,3 | +0,5 [−0,3, +1,4] |
| Judge: tái dùng code có sẵn | 7,5 | 7,8 | +0,3 [−0,9, +1,4] |
| Judge: chất lượng code | 7,6 | 8,0 | +0,4 [−0,4, +1,1] |
| File của PR mà agent cũng sửa (recall) | 90% | 92% | +3% [0%, +8%] |
| File agent sửa có trong PR (precision) | 97% | 97% | 0 |
| **Chi phí mỗi session** | **$0,34** | **$0,54** | **+$0,20 [+$0,13, +$0,26] (+58%)** |
| Token input (gồm cache) | 555k | 906k | +351k [+69k, +601k] |
| Tool call | 14,5 | 26,5 | +12,0 [+5,6, +17,5] |
| Thời gian thực (phút) | 15,6 | 15,9 | +0,4 [−13,1, +16,7] |
| Session chạm giới hạn thời gian | 0 / 8 | 1 / 8 | |

† Nếu coi lần fail ở 132188 là flaky (hiệu chỉnh 4).

Bảng theo từng task (Claude Code / + spec-nav): xem bảng tiếng Anh ở trên.

### Đọc kết quả

1. **Test ẩn không phân biệt được các cấu hình.** Sau hiệu chỉnh 1, mọi session đều pass test của PR. Bộ task này quá dễ để oracle đó cho thấy khác biệt.
2. **Không đo được khác biệt về chất lượng.** Mọi chênh lệch điểm judge, trừ "đúng", đều có khoảng tin cậy chứa 0. Về điểm tổng thể, spec-nav thắng 3 task, hoà 2, thua 3. Mức +0,4 đến từ task 133470, nơi judge được báo session Claude Code fail test ẩn; bỏ task đó thì chênh lệch là 0,0. Điểm "đúng" (+0,4, khoảng tin cậy vừa trên 0) chỉ là một lần chấm trên thang 1–10, nên coi là gợi ý, chưa phải kết luận.
3. **Tác động rõ ràng là chi phí.** Cấu hình spec-nav tốn thêm khoảng $0,20 (+58%) mỗi session, với +63% token input và khoảng 1,8 lần số tool call. Nguồn gốc: định nghĩa tool gửi ở mọi lượt, các lần gọi để khám phá code, và hook từ chối sửa code cho tới khi gọi đủ spec-nav theo yêu cầu. Với lần chạy này không tách được bao nhiêu chi phí đến từ bản thân MCP và bao nhiêu từ các lần gọi bị ép.
4. **Hồi quy.** spec-nav có hai:
   - Ở 132188, một lần `waitFor` của jest bị timeout trong `hooks.test.ts`, trong một lần chạy suite mất 306 giây. File `hooks.ts` của session spec-nav giống hệt từng byte với của session Claude Code (cùng blob `c197c739914`), mà test đó pass với Claude Code. Nhiều khả năng đây là test flaky, không phải do thay đổi của agent (hiệu chỉnh 4).
   - Ở 132784, session chạm giới hạn 60 phút khi đang sửa các test có sẵn trong `apistore/prepare_test.go`; hai test trong đó fail. Cấu hình nào cũng phải sửa file này.

   Claude Code có một: ở 129471 test `BrowseDashboardsPage` fail. Nếu coi 132188 là flaky thì cả hai cấu hình đều pass và không hồi quy ở 7/8 task.
5. **Điểm judge bỏ sót chỗ thiếu.** Review thủ công task 125681 cho thấy session spec-nav (judge: 9/10) bỏ sót ba chỗ PR có sửa, trong đó có `SetDefaultPermissionsAfterCreate`: dashboard ở root sẽ không còn được cấp quyền mặc định Editor/Viewer. Test ẩn cũng không bắt chỗ này.
6. **So với benchmark giả lập.** Agent giả lập (chính sách tất định) hưởng lợi lớn từ spec-nav, ví dụ tái dùng 40% → 93% trên session lớn của immich. Lần chạy LLM thật này không tái hiện được điều đó: với Claude Sonnet 5.5 và Grep, agent đã tìm được khoảng 90% file của PR. Baseline giả lập yếu hơn model thật.
7. Thêm spec-nav vào workflow framework cũng cho cùng kiểu kết quả: không đo được khác biệt về chất lượng, chi phí cao hơn (phần tiếp theo).

### Workflow framework

Ba cấu hình nữa chạy trên cùng các task:

- **Compass** — một workflow framework (rule, skill và sub-agent viết spec trước khi code). Tìm code bằng Grep. 8 task.
- **Compass + spec-nav** — như trên, có spec-nav nối vào Compass và các sub-agent của nó, cùng mục hướng dẫn và hook spec-nav như phần trên. 8 task.
- **ai-wf-bex + spec-nav** — một workflow framework chạy qua lệnh `/create` của nó, cài bằng script cài đặt của chính nó, cộng hook riêng chặn grep đệ quy vào code. Từ task 6 có thêm cổng *light* mô tả ở trên. Chỉ chạy ở task 4–8 (129554, 132188, 131474, 132784, 129471), nên n = 5.

Bảng số liệu đầy đủ của cả 5 cấu hình, chênh lệch theo cặp và bảng từng task: xem phần tiếng Anh ở trên.

Đọc kết quả:

1. **Không framework nào cải thiện chất lượng đo được.** Mọi chênh lệch điểm judge đều có khoảng tin cậy chứa 0. Khác biệt rõ chỉ có ở chi phí và token: Compass + spec-nav tốn hơn spec-nav $0,31 [+$0,14, +$0,50]; ai-wf-bex + spec-nav tốn hơn spec-nav $0,79 [+$0,54, +$1,12] và hơn Claude Code $1,00 [+$0,76, +$1,36]. Thêm spec-nav vào Compass (n = 7): judge 0,0 [−1,0, +0,9], tốn thêm $0,25 [−$0,05, +$0,53].
2. **Compass + spec-nav** là cấu hình duy nhất không hồi quy, không lỗi, không timeout, nhưng với n = 7–8 thì "100% so với 88%" chỉ là một task. Nó sửa nhiều file ngoài PR nhất (0,6 mỗi session, precision 91%) và chậm nhất (trung bình 21 phút; 59,5 phút ở 131434).
3. **ai-wf-bex + spec-nav** nhanh nhất (8,1 phút) và đắt nhất ($1,30, 57,8 tool call). Nó hồi quy nhiều nhất (2/5), cả hai đều là assertion fail trong test có sẵn của component nó sửa (`BrowseFolderVariablesPage` ở 129471, `FolderRepo` ở 132188), không phải timeout. Nó không viết file test nào ở 3/5 task, trong khi Claude Code chỉ có 1/5 trên cùng các task; judge ghi "không có test" ở cả hai task bị hồi quy. Viết và chạy ít test hơn có thể giải thích cả tốc độ lẫn hồi quy; transcript không lưu input của tool nên chưa kiểm chứng được. Session nào của nó cũng cần thêm một prompt từ user giả lập, vốn được xem diff tham khảo.
4. **Không so sánh được điểm spec.** Các framework còn viết spec và judge có chấm. Báo cáo tổng hợp ghi Compass 6,0 so với Compass + spec-nav 7,7, và trích dẫn `path:line` hợp lệ 9% so với 78%. Nhưng Compass chỉ có spec được chấm ở 2 task (129471, 132188), còn Compass + spec-nav ở 3 task khác (125681, 129554, 133470), không có task nào trùng. Đó không phải so sánh theo cặp, và n chỉ là 2 và 3. ai-wf-bex + spec-nav được chấm ở cả 5 task: spec 7,4, độ phủ blast radius 8,4, trích dẫn hợp lệ 67%.
5. **Số tool call trong sub-agent ghi là 0 ở mọi cấu hình, kể cả Compass vốn dùng sub-agent.** Hoặc sub-agent không được dùng, hoặc harness không đếm được; cần kiểm tra trước khi trích dẫn số tool call hay chi phí của Compass.

### Các hiệu chỉnh đã áp dụng

| # | Session | Chuyện gì xảy ra | Kết quả sau hiệu chỉnh |
|---|---|---|---|
| 1 | 133470, Claude Code | Test Go ẩn không biên dịch được: agent đã tự viết một test trùng tên hàm (`TestDashboardsAPIBuilderMutateNotebook redeclared`). Logic chưa hề được test. | Tính là pass. Điểm judge (6) không chỉnh vì judge chấm khi được báo "test ẩn: FAIL". |
| 2 | 132188, Compass + spec-nav | Bộ test hồi quy chạm giới hạn 20 phút. | Loại khỏi chỉ số "không hồi quy". |
| 3 | 132784, Compass | Session lỗi; chi phí bị ghi là $0. | Loại khỏi chi phí, token và thời gian. |
| 4 | 132188, + spec-nav | Một lần `waitFor` của jest timeout trong `hooks.test.ts`. File `hooks.ts` đã sửa giống hệt từng byte với của session Claude Code, mà session đó pass cùng test. | Không áp vào số chính; ghi là †. Nhiều khả năng flaky. |

### Giới hạn và việc cần sửa

- **Chưa đo cấu hình chỉ có MCP.** Mọi session spec-nav đều có kèm hướng dẫn và hook ép dùng. Dự kiến: thêm một arm chỉ cài MCP, không hook (và một arm có hướng dẫn nhưng không hook), để đọc được tác động của riêng MCP.
- **Chọn lần chạy ở task 125681.** Cấu hình spec-nav đã chạy 5 lần trên task này trong lúc đang tinh chỉnh; chỉ giữ lần cuối. Các task khác chạy một lần. Bước tiếp theo: chạy lại 125681 với cấu hình cuối cùng.
- **Cấu hình thay đổi giữa chừng.** Hook và hướng dẫn đã qua ba chế độ (xem phần Cách đo); spec-nav có 7 tool đến task 7 và 8 tool từ task 8. Vì vậy "+ spec-nav" không phải một cấu hình cố định; mỗi chế độ chỉ có 3–4 task nên không so sánh được các chế độ với nhau.
- **Mỗi cặp (task, cấu hình) chạy một lần.** Chưa đo độ dao động của agent; chênh lệch một điểm judge nằm trong mức dao động đó. Dự kiến: ít nhất 3 lần lặp.
- **Judge.** Cùng model với agent, chấm một lần mỗi task. Judge được báo test ẩn pass hay fail, nên lỗi của harness đi thẳng vào điểm (hiệu chỉnh 1). Diff bị cắt ở 15.000 ký tự: ở 4 task, judge ghi rằng không thấy hết diff.
- **Cô lập test ẩn.** Test agent tự viết có thể trùng với test ẩn (hiệu chỉnh 1). Dự kiến: chạy test ẩn tách riêng.
- **Chạy test hồi quy.** Timeout bị tính là fail, test flaky không được chạy lại (hiệu chỉnh 2 và 4). Nhiều cấu hình chạy jest cùng lúc nên `waitFor` dễ timeout hơn. Dự kiến: chạy lại mỗi lần fail một lần và tăng timeout của jest.
- **Việc chọn lần chạy cũng ảnh hưởng tới Compass + spec-nav:** cấu hình này chạy 4 lần ở task 125681, chỉ giữ lần cuối.
- **User giả lập thấy diff tham khảo.** Càng nhiều prompt hỏi lại thì càng nhiều gợi ý (1,3 so với 1,1 prompt mỗi session).
- **Phạm vi.** Một model, một repo và 8 task: 4 feature, 2 bugfix, 2 refactor.

## 简体中文

**状态：中期结果——8 个任务，记录于 2026-10-14 至 2026-10-15。随着任务和重复次数增加，本报告会更新。**

> **这里的"+ spec-nav"指什么。** 它**不只是 MCP**。它是 spec-nav MCP **加上** `AGENTS.md`/`CLAUDE.md` 中的说明，**再加上**一个**强制**代理使用 spec-nav 的 Claude Code 钩子：在调用一组 spec-nav 工具之前阻止首次修改代码，后期任务中还禁止递归 grep。**仅安装 MCP（不强制调用）的设置尚未测量。** 因此这些结果并不表明 Claude Code 不用 MCP 更好：它比较的是纯 Claude Code 与强制调用 spec-nav 的设置。额外的成本和工具调用有一部分来自强制调用。

### 设置

- **任务：** 8 个已合并的 Grafana pull request（125681、129471、129554、131434、131474、132188、132784、133470）。每个会话从 PR 之前的提交开始。代理拿到的是根据 issue 写的任务描述，而不是 diff。每个任务都涉及代码库中至少两个区域；其中 2 个同时涉及 Go 和 TypeScript。
- **判定标准：** PR 自带的测试，对代理隐藏（`resolved`），以及 PR 涉及包的 `go vet`/测试/jest（`无回归`）。
- **代理：** Claude Code，模型 Claude Sonnet 5.5，每个会话限时 60 分钟。
- **本报告比较的两种设置：**
  - **Claude Code**——不使用 MCP。
  - **Claude Code + spec-nav**——spec-nav MCP、`AGENTS.md`/`CLAUDE.md` 中的 spec-nav 章节，以及一个 Claude Code 钩子。钩子和说明在运行过程中有变化（任务按运行顺序）：
    - 任务 1–4（125681、131434、133470、129554），*require*：首次修改代码前必须已调用 services、map、find_functions、functions、read_function 和 callers，新增函数前须调用 similar_functions；允许 grep。
    - 任务 5（132188），*steer*：无编辑闸门；禁止对代码递归 grep，并引导至 spec-nav。
    - 任务 6–8（131474、132784、129471），*light*：首次编辑前须已调用 map + find_functions + callers，且 spec-nav 总调用至少 7 次；禁止递归 grep。
- **模拟用户：** Claude Sonnet 5.5。它能看到参考 diff，回答代理的追问但不透露标识符；未检测到泄露。
- **代码评审：** Claude Sonnet 5.5，盲评（标签打乱），每个任务评一次。评审能看到参考 diff（前 20,000 字符）、各设置的 diff（前 15,000 字符）以及隐藏测试是否通过，打 1–10 分。
- **成本：** 仅计代理，按标价折算；不含模拟用户。
- 每个（任务，设置）只运行一次。95% 区间：按任务配对 bootstrap。

另有三种使用工作流框架（Compass 和 ai-wf-bex）的设置在同一批任务上运行；见[工作流框架](#工作流框架)。

### 结果（n = 8，已应用下列修正）

| 指标（每会话均值） | Claude Code | + spec-nav（MCP + 说明 + 强制钩子） | 差值 [95% CI] |
|---|---:|---:|---:|
| 隐藏测试通过 | 100%（原始 88%） | 100% | 0 |
| 通过且无回归 | 88%（原始 75%） | 75%（88%†） | −13% [−50%, +25%]（0†） |
| 评审：总体（1–10） | 7.8 | 8.1 | +0.4 [−0.5, +1.4] |
| 评审：总体，去掉任务 133470（n = 7） | — | — | 0.0 [−0.7, +0.9] |
| 评审：正确性 | 8.3 | 8.6 | +0.4 [+0.1, +0.8] |
| 评审：完整性 | 7.8 | 8.3 | +0.5 [−0.3, +1.4] |
| 评审：复用已有代码 | 7.5 | 7.8 | +0.3 [−0.9, +1.4] |
| 评审：代码质量 | 7.6 | 8.0 | +0.4 [−0.4, +1.1] |
| PR 修改的文件中代理也修改的比例（召回） | 90% | 92% | +3% [0%, +8%] |
| 代理修改的文件中 PR 也修改的比例（精确） | 97% | 97% | 0 |
| **每会话成本** | **$0.34** | **$0.54** | **+$0.20 [+$0.13, +$0.26]（+58%）** |
| 输入 token（含缓存） | 555k | 906k | +351k [+69k, +601k] |
| 工具调用 | 14.5 | 26.5 | +12.0 [+5.6, +17.5] |
| 实际耗时（分钟） | 15.6 | 15.9 | +0.4 [−13.1, +16.7] |
| 达到时间上限的会话 | 0 / 8 | 1 / 8 | |

† 若将 132188 的失败视为不稳定测试（修正 4）。

逐任务结果（Claude Code / + spec-nav）：见上方英文表格。

### 解读

1. **隐藏测试无法区分两种设置。** 应用修正 1 后，所有会话都通过了 PR 的测试。这组任务对该判定标准来说太容易，显示不出差异。
2. **质量差异不可测。** 除正确性外，所有评审差值的区间都包含 0。按总体分，spec-nav 赢 3 个任务、平 2 个、输 3 个。其 +0.4 来自任务 133470：评审被告知 Claude Code 会话未通过隐藏测试；去掉该任务后差值为 0.0。正确性（+0.4，区间略高于 0）只是 1–10 分制下的一次评分，应视为线索而非结论。
3. **明确的影响是成本。** spec-nav 设置每会话多花约 $0.20（+58%），输入 token 多 63%，工具调用约为 1.8 倍。来源是每轮都发送的工具定义、探索调用，以及在完成所需 spec-nav 调用前拒绝修改的钩子。本次运行无法区分额外成本中有多少来自 MCP 本身、多少来自强制调用。
4. **回归。** spec-nav 有两次：
   - 132188 中，`hooks.test.ts` 的一次 jest `waitFor` 超时，该次测试套件运行耗时 306 秒。spec-nav 会话的 `hooks.ts` 与 Claude Code 会话的逐字节相同（同一 blob `c197c739914`），而该测试在 Claude Code 会话中通过。这很可能是不稳定测试，而不是代理修改造成的（修正 4）。
   - 132784 中，会话在修改 `apistore/prepare_test.go` 中已有测试时达到 60 分钟上限；其中两个测试失败。每种设置都需要修改该文件。

   Claude Code 有一次：129471 中 `BrowseDashboardsPage` 测试失败。若将 132188 视为不稳定测试，两种设置都在 8 个任务中的 7 个上通过且无回归。
5. **评审分数会漏掉遗漏。** 人工审查任务 125681 发现，spec-nav 会话（评审 9/10）漏掉了 PR 修改的三处，其中包括 `SetDefaultPermissionsAfterCreate`：根目录下的仪表盘将不再获得默认的 Editor/Viewer 权限。隐藏测试也未覆盖这一点。
6. **与模拟基准对比。** 模拟代理（确定性策略）从 spec-nav 获益很大，例如 immich 大型会话中复用率 40% → 93%。本次真实运行没有重现这一点：使用 Claude Sonnet 5.5 和 Grep，代理已能找到 PR 约 90% 的文件。模拟基线比真实模型弱。
7. 在工作流框架中加入 spec-nav 呈现相同模式：质量差异不可测，成本更高（见下一节）。

### 工作流框架

另外三种设置在同一批任务上运行：

- **Compass**——一个工作流框架（规则、技能以及在编码前编写 spec 的子代理），使用 Grep 搜索代码。8 个任务。
- **Compass + spec-nav**——同上，并将 spec-nav 接入 Compass 及其子代理，使用与上文相同的 spec-nav 章节和钩子。8 个任务。
- **ai-wf-bex + spec-nav**——一个通过其自身 `/create` 命令运行的工作流框架，用其自带安装脚本安装，另有其自带的钩子禁止对代码递归 grep。从任务 6 起加入上文所述的 *light* 闸门。只在任务 4–8（129554、132188、131474、132784、129471）上运行，因此 n = 5。

五种设置的完整数据、配对差值和逐任务表格：见上方英文部分。

解读：

1. **没有任何框架带来可测的质量提升。** 所有评审差值的区间都包含 0。明确的差异只在成本和 token：Compass + spec-nav 比 spec-nav 多 $0.31 [+$0.14, +$0.50]；ai-wf-bex + spec-nav 比 spec-nav 多 $0.79 [+$0.54, +$1.12]，比 Claude Code 多 $1.00 [+$0.76, +$1.36]。在 Compass 中加入 spec-nav（n = 7）：评审 0.0 [−1.0, +0.9]，多 $0.25 [−$0.05, +$0.53]。
2. **Compass + spec-nav** 是唯一无回归、无错误、无超时的设置，但在 n = 7–8 时"100% 对 88%"只差一个任务。它修改 PR 以外文件最多（每会话 0.6 个，精确率 91%），也最慢（平均 21 分钟；131434 上 59.5 分钟）。
3. **ai-wf-bex + spec-nav** 最快（8.1 分钟）也最贵（$1.30，57.8 次工具调用）。它的回归最多（5 个中 2 个），都是其修改过的组件已有测试中的断言失败（129471 的 `BrowseFolderVariablesPage`、132188 的 `FolderRepo`），而不是超时。它在 5 个任务中有 3 个没有写任何测试文件，而 Claude Code 在相同任务中只有 1 个；评审在两个回归任务上都注明"没有测试"。写和运行更少的测试可能同时解释了速度和回归；但会话记录不保存工具输入，因此尚未验证。它的每个会话都需要模拟用户（能看到参考 diff）再给一次提示。
4. **spec 分数无法比较。** 这些框架还会编写 spec 并由评审打分。汇总报告显示 Compass 6.0 对 Compass + spec-nav 7.7，有效 `path:line` 引用 9% 对 78%。但 Compass 只有 2 个任务（129471、132188）有评分的 spec，Compass + spec-nav 在另外 3 个任务（125681、129554、133470），没有重叠。这不是配对比较，n 只有 2 和 3。ai-wf-bex + spec-nav 的 5 个任务都有评分：spec 7.4，影响范围覆盖 8.4，有效引用 67%。
5. **所有设置中子代理内的工具调用都记录为 0，包括使用子代理的 Compass。** 要么没有使用子代理，要么测试框架没有统计；引用 Compass 的工具调用或成本数字前应先核实。

### 已应用的修正

| # | 会话 | 发生了什么 | 修正后结果 |
|---|---|---|---|
| 1 | 133470，Claude Code | 隐藏的 Go 测试无法编译：代理自己写了一个同名测试函数（`TestDashboardsAPIBuilderMutateNotebook redeclared`）。其逻辑从未被测试。 | 计为通过。评审分（6）未调整，因为评审时被告知"隐藏测试：FAIL"。 |
| 2 | 132188，Compass + spec-nav | 回归测试达到 20 分钟上限。 | 不计入"无回归"。 |
| 3 | 132784，Compass | 会话出错，成本记录为 $0。 | 不计入成本、token 和耗时。 |
| 4 | 132188，+ spec-nav | `hooks.test.ts` 中一次 jest `waitFor` 超时。修改后的 `hooks.ts` 与 Claude Code 会话的逐字节相同，而后者通过了同一测试。 | 不用于主要数字；以 † 标注。很可能是不稳定测试。 |

### 局限与计划修复

- **尚未测量仅有 MCP 的设置。** 每个 spec-nav 会话都同时带有说明和强制钩子。计划：增加只安装 MCP、无钩子的组（以及有说明但无钩子的组），以便看出 MCP 本身的效果。
- **任务 125681 的运行选择。** spec-nav 设置在调整期间于该任务上运行了 5 次，只保留最后一次。其他任务只运行一次。下一步：用最终设置重跑 125681。
- **设置在基准测试期间有变化。** 钩子和说明经历了三种模式（见"设置"）；spec-nav 在任务 7 及之前提供 7 个工具，从任务 8 起提供 8 个。因此"+ spec-nav"并非单一固定设置；每种模式只有 3–4 个任务，无法相互比较。
- **每个（任务，设置）只运行一次。** 未测量代理自身的波动；一分的评审差异就在波动范围内。计划：至少重复 3 次。
- **评审。** 与代理是同一模型，每个任务评一次。评审会被告知隐藏测试是否通过，因此测试框架的错误会直接影响评分（修正 1）。diff 截断在 15,000 字符：有 4 个任务评审注明看不到完整 diff。
- **隐藏测试隔离。** 代理写的测试可能与隐藏测试冲突（修正 1）。计划：隔离运行隐藏测试。
- **回归测试运行。** 超时被计为失败，不稳定测试不重跑（修正 2 和 4）。多个设置同时运行 jest，使 `waitFor` 更容易超时。计划：每次失败重跑一次，并提高 jest 超时。
- **运行选择同样影响 Compass + spec-nav：** 它在任务 125681 上运行了 4 次，只保留最后一次。
- **模拟用户能看到参考 diff。** 追问越多，提示越多（每会话 1.3 对 1.1 次提示）。
- **范围。** 一个模型、一个仓库、8 个任务：4 个功能、2 个缺陷修复、2 个重构。
