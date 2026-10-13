# Benchmark spec-nav: có MCP vs không MCP

- Repo: immich@cc7fd67 (repo thật; đáp án: findReferences của TypeScript, doc comment, ripgrep) — 1,961 file, 217,149 dòng.
- 20 session thường (1 feature: tái sử dụng + đổi signature một hàm + đổi một hằng số + đọc và sửa code) và 10 session lớn (gộp 3 feature trong một context).
- Mỗi session chạy 2 lần: không MCP (Grep = ripgrep với head_limit 250, Read = cat -n, Edit) và có MCP (spec-nav, server mới mỗi session = cold start; vẫn có Read/Edit).
- Token ước lượng 3.5 ký tự/token cho cả hai bên. Định nghĩa tool MCP ~3,781 token được cộng vào mỗi lượt của phía có MCP. Base context (system prompt, tool built-in) = 0 token/lượt cho cả hai.
- Agent là chính sách tất định, không phải LLM. Xem bench/README.md về giả định và giới hạn.

## 20 session thường

### Chất lượng

| Chỉ số (trung bình / session) | Không MCP | Có MCP | Chênh (MCP − không) | 95% CI của chênh |
|---|---:|---:|---:|---:|
| session đúng hoàn toàn | 50% | 85% | +35% | [+10%, +60%] |
| tái sử dụng được hàm có sẵn | 55% | 90% | +35% | [+10%, +60%] |
| callers: recall | 100% | 100% | 0% | [0%, 0%] |
| callers: precision | 97% | 98% | +1% | [0%, +2%] |
| callers: đủ hết, không thừa | 85% | 90% | +5% | [0%, +15%] |
| survey: recall | 100% | 100% | 0% | [0%, 0%] |
| survey: đủ hết, không thừa | 100% | 100% | 0% | [0%, 0%] |
| chỗ sửa nhầm (wrong edits) | 0.3 | 0.2 | −0.1 (−43%) | [−0.4, 0.0] |
| chỗ cần sửa bị sót (missed edits) | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |

### Chi phí

| Chỉ số (trung bình / session) | Không MCP | Có MCP | Chênh (MCP − không) | 95% CI của chênh |
|---|---:|---:|---:|---:|
| tool calls (= lượt model) | 45.3 | 44.4 | −0.9 (−2%) | [−4.1, +1.6] |
| token context cuối session | 115,898 | 97,571 | −18,328 (−16%) | [−32,743, −8,145] |
|   trong đó: pha tìm kiếm | 25,757 | 7,623 | −18,134 (−70%) | [−32,474, −8,092] |
|   trong đó: pha đọc + sửa | 90,142 | 89,948 | −194 (−0%) | [−737, +218] |
| token input tích lũy (không cache) | 4,015,626 | 3,327,531 | −688,096 (−17%) | [−1,212,860, −261,611] |
| token input quy đổi (có prompt cache) | 534,846 | 449,308 | −85,538 (−16%) | [−151,342, −31,579] |
| token output (tham số tool) | 2,256 | 2,182 | −74 (−3%) | [−173, +11] |
| thời gian tool, gồm khởi động MCP (ms) | 123 | 3,289 | +3,166 (+2573%) | [+3,040, +3,309] |

| Token context / session | Không MCP | Có MCP |
|---|---:|---:|
| min | 22,426 | 29,632 |
| median | 93,206 | 79,180 |
| p90 | 191,248 | 172,458 |
| max | 213,097 | 180,813 |
| tổng 20 session | 2,317,964 | 1,951,414 |
| tổng input tích lũy (có cache) | 10,696,910 | 8,986,151 |

### Theo độ khó của bước tái sử dụng

| Độ khó | n | tìm thấy: không MCP | tìm thấy: có MCP | token tìm kiếm: không MCP | token tìm kiếm: có MCP |
|---|---:|---:|---:|---:|---:|
| real-doc | 20 | 55% | 90% | 25,757 | 7,623 |

### Theo ngôn ngữ của hàm cần đổi signature

| Ngôn ngữ | n | callers đủ & không thừa: không MCP | callers đủ & không thừa: có MCP | token tìm kiếm: không MCP | token tìm kiếm: có MCP |
|---|---:|---:|---:|---:|---:|
| typescript | 20 | 85% | 90% | 25,757 | 7,623 |

### Session chỉ một bên làm đúng hoàn toàn

- Chỉ MCP đúng (8): session-001, session-002, session-007, session-009, session-012, session-013, session-016, session-020
- Chỉ không-MCP đúng (1): session-006

<details><summary>Các việc con thất bại</summary>

Không MCP:
- session-001: reuse reuse-001 (real-doc)
- session-002: reuse reuse-002 (real-doc)
- session-004: reuse reuse-004 (real-doc)
- session-004: callers callers-004 missed  extra web/src/lib/components/timeline/TimelineAssetViewer.svelte:54 web/src/lib/components/timeline/TimelineAssetViewer.svelte:62
- session-007: reuse reuse-007 (real-doc)
- session-009: reuse reuse-009 (real-doc)
- session-012: callers callers-012 missed  extra server/src/maintenance/maintenance-worker.service.ts:223 server/src/maintenance/maintenance-worker.service.ts:224
- session-013: reuse reuse-013 (real-doc)
- session-014: reuse reuse-014 (real-doc)
- session-014: callers callers-014 missed  extra server/src/controllers/person.controller.ts:232 web/src/lib/modals/PersonEditAccessModal.svelte:36 web/src/lib/modals/PersonEditAccessModal.svelte:37
- session-016: reuse reuse-016 (real-doc)
- session-020: reuse reuse-020 (real-doc)

Có MCP:
- session-004: callers callers-004 missed  extra web/src/lib/components/timeline/TimelineAssetViewer.svelte:44 web/src/lib/utils/navigation.ts:24
- session-006: reuse reuse-006 (real-doc)
- session-014: reuse reuse-014 (real-doc)
- session-014: callers callers-014 missed  extra web/src/lib/modals/PersonEditAccessModal.svelte:36 web/src/lib/modals/PersonEditAccessModal.svelte:37

</details>

## 10 session lớn

### Chất lượng

| Chỉ số (trung bình / session) | Không MCP | Có MCP | Chênh (MCP − không) | 95% CI của chênh |
|---|---:|---:|---:|---:|
| session đúng hoàn toàn | 0% | 30% | +30% | [0%, +60%] |
| tái sử dụng được hàm có sẵn | 40% | 93% | +53% | [+40%, +67%] |
| callers: recall | 94% | 99% | +5% | [−1%, +14%] |
| callers: precision | 77% | 92% | +16% | [+7%, +26%] |
| callers: đủ hết, không thừa | 53% | 73% | +20% | [+7%, +33%] |
| survey: recall | 100% | 100% | 0% | [0%, 0%] |
| survey: đủ hết, không thừa | 100% | 100% | 0% | [0%, 0%] |
| chỗ sửa nhầm (wrong edits) | 14.4 | 2.4 | −12.0 (−83%) | [−25.5, −2.1] |
| chỗ cần sửa bị sót (missed edits) | 1.3 | 0.3 | −1.0 (−77%) | [−3.1, +0.6] |

### Chi phí

| Chỉ số (trung bình / session) | Không MCP | Có MCP | Chênh (MCP − không) | 95% CI của chênh |
|---|---:|---:|---:|---:|
| tool calls (= lượt model) | 146.9 | 117.7 | −29.2 (−20%) | [−55.6, −7.6] |
| token context cuối session | 302,494 | 226,515 | −75,979 (−25%) | [−107,686, −47,230] |
|   trong đó: pha tìm kiếm | 67,345 | 21,188 | −46,157 (−69%) | [−60,850, −33,339] |
|   trong đó: pha đọc + sửa | 235,149 | 205,327 | −29,822 (−13%) | [−63,501, −1,460] |
| token input tích lũy (không cache) | 29,156,601 | 17,472,270 | −11,684,331 (−40%) | [−19,310,764, −5,607,984] |
| token input quy đổi (có prompt cache) | 3,263,528 | 2,012,067 | −1,251,461 (−38%) | [−2,050,084, −617,511] |
| token output (tham số tool) | 7,144 | 5,635 | −1,509 (−21%) | [−2,757, −542] |
| thời gian tool, gồm khởi động MCP (ms) | 358 | 6,935 | +6,577 (+1839%) | [+5,164, +8,497] |

| Token context / session | Không MCP | Có MCP |
|---|---:|---:|
| min | 238,575 | 156,835 |
| median | 302,305 | 230,502 |
| p90 | 337,446 | 275,078 |
| max | 399,815 | 275,499 |
| tổng 10 session | 3,024,940 | 2,265,150 |
| tổng input tích lũy (có cache) | 32,635,283 | 20,120,673 |

### Session chỉ một bên làm đúng hoàn toàn

- Chỉ MCP đúng (3): large-007, large-009, large-010
- Chỉ không-MCP đúng (0): không có

<details><summary>Các việc con thất bại</summary>

Không MCP:
- large-001: reuse reuse-021 (real-doc)
- large-001: callers callers-021 missed  extra server/src/services/database-backup.service.spec.ts:78 server/src/services/database-backup.service.spec.ts:97 server/src/services/integrity.service.ts:111 server/src/services/library.service.spec.ts:47 server/src/services/library.service.spec.ts:121 server/src/services/library.service.spec.ts:130 server/src/services/library.service.spec.ts:147 server/src/services/library.service.spec.ts:151 server/src/services/metadata.service.spec.ts:132 server/src/services/notification.service.spec.ts:67 server/src/services/queue.service.spec.ts:24 server/src/services/version.service.spec.ts:146 server/src/services/version.service.spec.ts:154 server/src/services/version.service.spec.ts:162
- large-001: reuse reuse-022 (real-doc)
- large-001: callers callers-023 missed  extra server/src/controllers/download.controller.ts:24 web/src/lib/utils/asset-utils.ts:57
- large-002: reuse reuse-024 (real-doc)
- large-002: callers callers-024 missed  extra web/src/lib/services/library.service.ts:62
- large-002: reuse reuse-026 (real-doc)
- large-003: reuse reuse-027 (real-doc)
- large-003: callers callers-027 missed  extra server/src/controllers/search.controller.ts:112 web/src/lib/components/faces-page/PeopleSearch.svelte:86 web/src/routes/(user)/people/[personId]/[[photos=photos]]/[[assetId=id]]/+page.svelte:241 web/src/routes/(user)/people/+page.svelte:259
- large-003: reuse reuse-028 (real-doc)
- large-003: reuse reuse-029 (real-doc)
- large-004: callers callers-030 missed  extra server/src/controllers/person.controller.ts:184 server/src/services/person.service.ts:642 server/src/services/person.service.ts:735 web/src/routes/(user)/people/[personId]/[[photos=photos]]/[[assetId=id]]/UnmergeFaceSelector.svelte:72 web/src/routes/(user)/people/[personId]/[[photos=photos]]/[[assetId=id]]/UnmergeFaceSelector.svelte:89
- large-004: reuse reuse-031 (real-doc)
- large-004: callers callers-031 missed  extra server/src/services/base.service.ts:304
- large-004: reuse reuse-032 (real-doc)
- large-005: reuse reuse-033 (real-doc)
- large-005: callers callers-034 missed server/test/medium/specs/services/plugin.service.spec.ts:36 server/test/medium/specs/services/plugin.service.spec.ts:57 server/test/medium/specs/services/plugin.service.spec.ts:103 server/test/medium/specs/services/plugin.service.spec.ts:174 server/test/medium/specs/services/plugin.service.spec.ts:231 extra server/src/controllers/asset-file.controller.ts:30 server/src/controllers/memory.controller.ts:32 server/src/controllers/notification.controller.ts:30 server/src/controllers/partner.controller.ts:24 server/src/controllers/stack.controller.ts:25 server/src/controllers/user-admin.controller.ts:34 server/src/controllers/user.controller.ts:52 server/src/controllers/workflow.controller.ts:44
- large-005: reuse reuse-035 (real-doc)
- large-005: callers callers-035 missed  extra e2e/src/specs/server/cli/login.e2e-spec.ts:51 server/src/bin/sync-sql.ts:187 server/src/repositories/config.repository.ts:150 server/src/repositories/crypto.repository.ts:59 server/src/repositories/database.repository.ts:429 server/src/repositories/server-info.repository.ts:111 server/src/repositories/server-info.repository.ts:116 server/src/repositories/storage.repository.ts:304 server/src/repositories/storage.repository.ts:305 server/src/repositories/storage.repository.ts:306 server/src/repositories/telemetry.repository.ts:159 server/src/repositories/view-repository.ts:26 server/src/repositories/view-repository.ts:31 server/src/schema/migrations/1752759108283-ConvertToAbsolutePaths.ts:19 server/src/services/integrity.service.ts:157 server/src/services/metadata.service.ts:642 server/src/services/storage-template.service.ts:416 server/src/services/storage-template.service.ts:437 server/src/services/sync.service.ts:269 server/src/services/workflow-execution.service.ts:98 server/src/utils/misc.ts:153 server/src/utils/misc.ts:179 server/src/utils/replace-template-tags.ts:2 web/src/lib/elements/__test__/FormatMessage.spec.ts:8 web/src/lib/i18n.spec.ts:13 web/src/lib/route.ts:6 web/src/lib/route.ts:10 web/src/lib/utils/i18n.ts:30 web/src/lib/utils/string-utils.ts:2 web/src/routes/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]/AlbumTitle.svelte:22 web/src/routes/admin/system-settings/BackupSettings.svelte:56 web/src/routes/admin/system-settings/IntegrityChecksSettings.svelte:49 web/src/routes/admin/system-settings/IntegrityChecksSettings.svelte:88 web/src/routes/admin/system-settings/IntegrityChecksSettings.svelte:127 web/src/routes/admin/system-settings/LibrarySettings.svelte:78
- large-006: reuse reuse-036 (real-doc)
- large-006: reuse reuse-037 (real-doc)
- large-006: callers callers-037 missed  extra server/src/services/person.service.ts:379 server/src/services/person.service.ts:526 server/src/services/person.service.ts:903
- large-006: callers callers-038 missed  extra server/src/controllers/search.controller.ts:78 server/src/services/search.service.ts:159 web/src/routes/(user)/utilities/large-files/[[photos=photos]]/[[assetId=id]]/+page.ts:8
- large-007: reuse reuse-041 (real-doc)
- large-008: reuse reuse-042 (real-doc)
- large-008: callers callers-042 missed  extra server/src/services/asset.service.ts:437
- large-008: callers callers-043 missed  extra e2e/src/ui/specs/timeline/timeline.e2e-spec.ts:493 e2e/src/ui/specs/timeline/timeline.e2e-spec.ts:535 server/src/services/cluster-group.service.ts:67 server/src/services/cluster-group.service.ts:72
- large-008: reuse reuse-044 (real-doc)
- large-009: reuse reuse-046 (real-doc)
- large-010: reuse reuse-048 (real-doc)
- large-010: callers callers-048 missed server/src/services/api-key.service.spec.ts:264 server/src/services/auth.service.spec.ts:184 server/src/services/auth.service.spec.ts:1453 server/src/services/auth.service.spec.ts:1510 server/src/services/session.service.spec.ts:31 server/src/services/session.service.spec.ts:47 server/src/utils/search-filter.spec.ts:8 server/src/utils/search-filter.spec.ts:9 extra machine-learning/immich_ml/models/clip/visual.py:32 machine-learning/immich_ml/models/ocr/recognition.py:97 machine-learning/immich_ml/sessions/ort.py:68 machine-learning/immich_ml/sessions/prepare.py:36 machine-learning/immich_ml/sessions/prepare.py:61 machine-learning/test_main.py:206 machine-learning/test_main.py:211 machine-learning/test_main.py:812 machine-learning/test_main.py:1060 machine-learning/test_main.py:1079 machine-learning/test_main.py:1402 machine-learning/test_main.py:1711 machine-learning/test_main.py:1770 mobile/ios/Runner/Core/URLSessionManager.swift:63 mobile/ios/Runner/Core/URLSessionManager.swift:177 mobile/ios/Runner/Core/URLSessionManager.swift:178 mobile/ios/Runner/Core/URLSessionManager.swift:186 mobile/ios/Runner/Core/URLSessionManager.swift:187 mobile/ios/Runner/Core/URLSessionManager.swift:211 mobile/ios/Runner/Core/URLSessionManager.swift:220 mobile/ios/Runner/Core/URLSessionManager.swift:230 mobile/ios/Runner/Core/URLSessionManager.swift:231 e2e/src/ui/generators/memory/model-objects.ts:66 e2e/src/ui/generators/memory/model-objects.ts:83 e2e/src/ui/generators/timeline/model-objects.ts:167 e2e/src/ui/generators/timeline/model-objects.ts:172 e2e/src/ui/generators/timeline/model-objects.ts:234 e2e/src/ui/generators/timeline/rest-response.ts:63 e2e/src/ui/generators/timeline/rest-response.ts:64 e2e/src/ui/generators/timeline/rest-response.ts:65 e2e/src/ui/generators/timeline/rest-response.ts:260 e2e/src/ui/generators/timeline/rest-response.ts:362 e2e/src/ui/generators/timeline/rest-response.ts:397 e2e/src/ui/generators/timeline/rest-response.ts:403 e2e/src/ui/generators/timeline/rest-response.ts:409 e2e/src/ui/generators/timeline/utils.ts:64 e2e/src/ui/generators/timeline/utils.ts:137 e2e/src/ui/mock-network/broken-asset-network.ts:88 e2e/src/ui/mock-network/broken-asset-network.ts:89 e2e/src/ui/specs/asset-viewer/utils.ts:64 LICENSE:112
- large-010: callers callers-050 missed  extra server/src/services/database-backup.service.spec.ts:46 server/src/services/database-backup.service.spec.ts:54 server/src/services/database-backup.service.spec.ts:61 server/src/services/database-backup.service.spec.ts:72 server/src/services/database-backup.service.spec.ts:96 server/src/services/database-backup.service.ts:58 server/src/services/integrity.service.ts:69 server/src/services/metadata.service.spec.ts:120 server/src/services/smart-info.service.spec.ts:55 server/src/services/smart-info.service.spec.ts:65 server/src/services/smart-info.service.spec.ts:75 server/src/services/storage-template.service.spec.ts:28 server/src/services/storage-template.service.spec.ts:178 server/src/services/storage-template.service.spec.ts:222 server/src/services/storage-template.service.spec.ts:245 server/src/services/storage-template.service.spec.ts:273 server/src/services/storage-template.service.spec.ts:308 server/src/services/storage-template.service.spec.ts:342 server/src/services/storage-template.service.spec.ts:831 server/src/services/storage-template.service.spec.ts:873 server/src/services/storage-template.service.ts:105 server/src/services/system-config.service.ts:72

Có MCP:
- large-001: callers callers-023 missed  extra web/src/lib/utils/asset-utils.ts:57
- large-002: reuse reuse-024 (real-doc)
- large-003: callers callers-027 missed  extra web/src/lib/components/faces-page/PeopleSearch.svelte:86 web/src/routes/(user)/people/[personId]/[[photos=photos]]/[[assetId=id]]/+page.svelte:241 web/src/routes/(user)/people/+page.svelte:259
- large-004: callers callers-030 missed  extra web/src/routes/(user)/people/[personId]/[[photos=photos]]/[[assetId=id]]/UnmergeFaceSelector.svelte:72 web/src/routes/(user)/people/[personId]/[[photos=photos]]/[[assetId=id]]/UnmergeFaceSelector.svelte:89
- large-004: callers callers-032 missed server/src/utils/media.ts:815 server/src/utils/media.ts:901 server/src/utils/media.ts:903 extra 
- large-005: reuse reuse-033 (real-doc)
- large-005: callers callers-034 missed  extra web/src/lib/managers/search-manager.svelte.ts:33 web/src/lib/route.spec.ts:15 web/src/lib/route.spec.ts:19 web/src/lib/services/asset.service.ts:334 web/src/routes/(user)/search/[[photos=photos]]/[[assetId=id]]/+page.svelte:244
- large-005: callers callers-035 missed  extra server/src/repositories/crypto.repository.ts:59 server/src/repositories/storage.repository.ts:302 server/src/repositories/telemetry.repository.ts:159 server/src/repositories/view-repository.ts:26 server/src/services/integrity.service.ts:157 server/src/services/storage-template.service.ts:437 web/src/lib/i18n.spec.ts:13 web/src/lib/route.ts:6 web/src/routes/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]/AlbumTitle.svelte:22
- large-006: callers callers-038 missed  extra server/src/services/search.service.ts:159 web/src/routes/(user)/utilities/large-files/[[photos=photos]]/[[assetId=id]]/+page.ts:8
- large-008: callers callers-043 missed  extra server/src/services/cluster-group.service.ts:67 server/src/services/cluster-group.service.ts:72

</details>

