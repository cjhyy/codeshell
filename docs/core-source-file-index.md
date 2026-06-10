# Core 逐文件源码索引

- 生成时间：2026-06-02T00:16:52（目录计数与文件数已于 2026-06-10 按现状校对更新）
- 范围：`packages/core/src/**/*.ts`，排除 `*.test.ts`
- 文件数：319

## 目录

- `(root)`: 9 files
- `agent`: 2 files
- `arena`: 48 files
- `automation`: 7 files
- `capability-control`: 5 files
- `cli`: 3 files
- `context`: 4 files
- `cron`: 3 files
- `data`: 3 files
- `engine`: 19 files
- `external-agents`: 2 files
- `git`: 3 files
- `hooks`: 6 files
- `llm`: 23 files
- `logging`: 3 files
- `lsp`: 4 files
- `plugins`: 26 files
- `preset`: 1 files
- `product`: 3 files
- `prompt`: 5 files
- `protocol`: 11 files
- `remote`: 1 files
- `review`: 1 files
- `run`: 15 files
- `runtime`: 6 files
- `services`: 12 files
- `session`: 6 files
- `settings`: 6 files
- `skills`: 3 files
- `tool-system`: 64 files
- `utils`: 15 files

## 逐文件清单

### 1. `agent/agent-definition-registry.ts`

- 行数：82
- SHA1：`37bfbe6cb2b3c1ec98d8379af2b1224261258b02`
- 导出：AgentSourceDir, AgentDefinitionRegistry
- 类：AgentDefinitionRegistry
- 函数：（无）
- 方法/调用入口样本：has, get, list
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, any, path, join(

### 2. `agent/agent-definition.ts`

- 行数：90
- SHA1：`06c99810a0003b247f15bca1ba2e8800a2e20a57`
- 导出：AgentDefinition, parseAgentDefinition, serializeAgentDefinition
- 类：（无）
- 函数：parseAgentDefinition, serializeAgentDefinition
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, catch (, path, exec

### 3. `agent/coordinator.ts`

- 行数：107
- SHA1：`2044729e2744eb432ad5d5c62c8440803f1238d5`
- 导出：AgentInfo, AgentMessage, agentCoordinator
- 类：AgentCoordinator
- 函数：（无）
- 方法/调用入口样本：register, complete, fail, get, list, listActive, send, receive, peek, reset
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 4. `arena/arena.ts`

- 行数：410
- SHA1：`f888e31878a5825937ecc963a1cdaaf881dc30ab`
- 导出：Arena
- 类：Arena
- 函数：summarizeClaims
- 方法/调用入口样本：constructor, run, runPlanningPath, runReviewDiscussionPath
- 核心链路关键词：Arena
- 风险信号关键词：throw new Error, catch (, path, exec, silent

### 5. `arena/context/context-tools.ts`

- 行数：244
- SHA1：`dbb1ffbc47a4038de2f7bc1d18f42566a24b7236`
- 导出：MAX_TOOL_RESULT, MAX_TOOL_ROUNDS, CONTEXT_TOOLS, executeContextTool
- 类：（无）
- 函数：executeContextTool, validatePath, executeReadFile, executeGrepCode, executeListFiles, executeGitShow, executeGitBlame, sanitizeGitRef, execFileSafe, truncateResult
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, catch (, path, join(, exec, timeout

### 6. `arena/context/within-root.ts`

- 行数：15
- SHA1：`3bb418fb732a5980b0ddbc78b16800348cb59c9b`
- 导出：isWithinRoot
- 类：（无）
- 函数：isWithinRoot
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path

### 7. `arena/detect-mode.ts`

- 行数：106
- SHA1：`10e15f78e4863ce8237efa192c7d913ca0445bde`
- 导出：ArenaModeDetection, detectArenaMode
- 类：（无）
- 函数：detectArenaMode
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 8. `arena/digest-builder.ts`

- 行数：149
- SHA1：`ab0624fc9d81d1c5a677b41fb7b9c0a4b40cfe9c`
- 导出：buildDigest, formatDigest
- 类：（无）
- 函数：buildDigest, sanitize, formatDigest
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：join(

### 9. `arena/index.ts`

- 行数：117
- SHA1：`51bcb58ad110b3e8a8db89146fc78e4664efdd97`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 10. `arena/iterate/convergence.ts`

- 行数：112
- SHA1：`287f228386d269ede0a60556cf0698c2be4440d8`
- 导出：diffRatio, defaultConvergence
- 类：（无）
- 函数：diffRatio, defaultConvergence
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, timeout

### 11. `arena/iterate/formats/index.ts`

- 行数：317
- SHA1：`2bcc0c6e1b38084899b9bff235ad86350b6d3b3c`
- 导出：FormatPack, codeFormat, documentFormat, getFormat
- 类：（无）
- 函数：formatCritiquesForPrompt, getFormat
- 方法/调用入口样本：draftPrompt, mergePrompt, argueSystem, argueUser, revisePrompt, draftPrompt, mergePrompt, argueSystem, argueUser, revisePrompt, draftPrompt, mergePrompt, argueSystem, argueUser, revisePrompt
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path, join(

### 12. `arena/iterate/index.ts`

- 行数：31
- SHA1：`69bc46880897eaa738a2b46ddc047de2d0800831`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 13. `arena/iterate/iterative-arena.ts`

- 行数：264
- SHA1：`db176862deac9d9d7291dd954c7272df3518602e`
- 导出：IterativeArena
- 类：IterativeArena
- 函数：（无）
- 方法/调用入口样本：constructor, run, criticsForRound, checkConvergence, pickNextAuthor, finalize
- 核心链路关键词：Arena
- 风险信号关键词：throw new Error, catch (

### 14. `arena/iterate/parse.ts`

- 行数：131
- SHA1：`e35cad8b671847a732724b841bdc2ed2e5101686`
- 导出：extractTag, parseMergeResponse, ReviseMeta, parseReviseResponse, parseCritiquesResponse
- 类：（无）
- 函数：extractTag, parseMergeResponse, parseReviseResponse, parseCritiquesResponse
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, exec

### 15. `arena/iterate/phases/argue.ts`

- 行数：216
- SHA1：`10151b4de99f5ff26d5f7aaad0dcaf8a61050300`
- 导出：runArgueRound
- 类：（无）
- 函数：runArgueRound, argueSingleShot, argueWithToolLoop
- 方法/调用入口样本：（无）
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：catch (, any, path, exec, silent

### 16. `arena/iterate/phases/revise.ts`

- 行数：83
- SHA1：`354fe2835d8ab18d74f830e4c39db17ea6a1612b`
- 导出：runRevise
- 类：（无）
- 函数：runRevise
- 方法/调用入口样本：（无）
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：（无命中）

### 17. `arena/iterate/phases/tournament.ts`

- 行数：145
- SHA1：`07badd1032b5fb2e04843f44943233e60324a55f`
- 导出：runTournamentCandidates, mergeCandidatesToV1, singleAuthorV1
- 类：（无）
- 函数：runTournamentCandidates, mergeCandidatesToV1, singleAuthorV1
- 方法/调用入口样本：（无）
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：throw new Error, abort

### 18. `arena/iterate/tools/web-tools.ts`

- 行数：68
- SHA1：`1773d448ecc8dcc2edd4b4fc0e5e6f98a980a47e`
- 导出：webSearchToolDef, webFetchToolDef, ITERATE_WEB_TOOLS, executeIterateWebTool, hasWebSearchProvider
- 类：（无）
- 函数：executeIterateWebTool, hasWebSearchProvider
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, exec

### 19. `arena/iterate/types.ts`

- 行数：200
- SHA1：`66510b44fb7a521d6ebc9e047491cbc1a5b523ca`
- 导出：IterateFormat, IterateSubject, DraftCandidate, Draft, CritiqueSeverity, CritiqueCategory, CritiqueEvidence, Critique, ConvergenceSignal, Round, AuthorRotation, CheckpointContext, CheckpointAction, CheckpointFn, IterateProgressEvent, IterateConfig, StoppedReason, IterateResult
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：path, abort

### 20. `arena/ledger.ts`

- 行数：198
- SHA1：`5c687ebdf2c0aebf7b46066e5407206998358203`
- 导出：ArenaLedger
- 类：ArenaLedger
- 函数：（无）
- 方法/调用入口样本：constructor, checkGrowth, appendDossier, appendEvidencePacket, appendClaim, appendChallenge, appendRequestedCheck, appendAdjudication, getSnapshot, getClaimById, getPacketById, getAllClaims, getClaimsByStatus, getClaimsByOwner, getChallengesForClaim, getPendingChecks, getPendingChecksForClaim, getPacketsForClaim, getDossiers, getDossierByParticipant
- 核心链路关键词：Arena
- 风险信号关键词：any

### 21. `arena/lenses/architecture.ts`

- 行数：25
- SHA1：`c69f4fe680fee13f30a97626b4aaef7e26b97c87`
- 导出：architectureLens
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：path

### 22. `arena/lenses/engineering.ts`

- 行数：25
- SHA1：`adf589e51dbd4eabaf7242b11dfd9cc84d01b8e7`
- 导出：engineeringLens
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 23. `arena/lenses/general.ts`

- 行数：23
- SHA1：`2bcc7a2d442742e988c3c5f412c1999b1aeef145`
- 导出：generalLens
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 24. `arena/lenses/index.ts`

- 行数：58
- SHA1：`b52594fa9cba4a5257cd11ca5ce448a11084db5d`
- 导出：getLens, resolveLenses, buildLensPrompt, LENS_NAMES
- 类：（无）
- 函数：getLens, resolveLenses, buildLensPrompt
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：join(

### 25. `arena/lenses/product.ts`

- 行数：25
- SHA1：`6d2677773ec66e2b4f7f8b6a9e94aadde8af347a`
- 导出：productLens
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 26. `arena/model-presets.ts`

- 行数：53
- SHA1：`c47a75fbbb46dced8fac2e725ccebde544ffddfb`
- 导出：ModelPreset, MODEL_PRESETS, getMaxOutputTokens
- 类：（无）
- 函数：getMaxOutputTokens
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：path

### 27. `arena/phases/adjudication.ts`

- 行数：194
- SHA1：`cfa23faf10f9229bd6d8d519ab1912537a6a0036`
- 导出：runAdjudication
- 类：（无）
- 函数：runAdjudication, applyAdjudicationOutcome, buildFallbackAdjudicationPrompt
- 方法/调用入口样本：applyAdjudicationOutcome, markUnresolved, transitionClaim, transitionClaim, markUnresolved, return
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：join(

### 28. `arena/phases/build-consensus.ts`

- 行数：123
- SHA1：`9ad97a0125a317caf8d431269dfa2b6e0eefff7c`
- 导出：buildConsensus
- 类：（无）
- 函数：buildConsensus
- 方法/调用入口样本：（无）
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：path

### 29. `arena/phases/claim-registry.ts`

- 行数：87
- SHA1：`0bf7ce7af30a63af49fa0a12926f3d1f0f172825`
- 导出：registerClaims, selectClaimsForReview
- 类：（无）
- 函数：registerClaims, selectClaimsForReview
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 30. `arena/phases/cross-review.ts`

- 行数：304
- SHA1：`b66daa8e3147eba48c14bbd229ec5f245e79e544`
- 导出：runCrossReview, runVerificationReview
- 类：（无）
- 函数：runCrossReview, runVerificationReview
- 方法/调用入口样本：markUnderReview, applyReviewResult
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：path

### 31. `arena/phases/debate-rounds.ts`

- 行数：235
- SHA1：`f20f2698a3c265dc76de69f5e0e1e646e50d32eb`
- 导出：runDebateRounds
- 类：（无）
- 函数：runDebateRounds, debateClaim, findPrimaryChallenger, buildFallbackDebatePrompt
- 方法/调用入口样本：return, return
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：join(

### 32. `arena/phases/participant-research.ts`

- 行数：395
- SHA1：`ccd50eaf1cdacd3f12de7a2ce5f4c8d036cc8465`
- 导出：ResearchResult, runParticipantResearch, runParticipantResearchWithDossiers
- 类：（无）
- 函数：runParticipantResearch, runParticipantResearchWithDossiers, buildResultRef, generatePacketId, inferSourceKind, buildEvidencePacketFromTool, formatToolArgs, buildFindingEvidenceLinks
- 方法/调用入口样本：（无）
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：any, path, join(, exec

### 33. `arena/phases/planning-detail-expansion.ts`

- 行数：172
- SHA1：`b5ce57d27089e6e690527e4fdc481d16c94dc0bc`
- 导出：runDetailExpansion
- 类：（无）
- 函数：runDetailExpansion
- 方法/调用入口样本：（无）
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：path, exec

### 34. `arena/planner.ts`

- 行数：357
- SHA1：`9a91827b4fcdd2a0e1fdeeec1c7230e476d83c76`
- 导出：PlannerFlags, planArena
- 类：（无）
- 函数：planArena, parsePlanResponse, buildExplicitPlan, buildFallbackPlan, validateMode, validateConfidence, parseLenses, parseSources, parseSubject, parseOutputShape
- 方法/调用入口样本：（无）
- 核心链路关键词：createLLMClient, Arena
- 风险信号关键词：catch {, catch (, any, as any, path, exec

### 35. `arena/providers/docs.ts`

- 行数：115
- SHA1：`d925adb1f7d9b0a08b0ca5532338a280fe32fb98`
- 导出：docsProvider, truncate
- 类：（无）
- 函数：findDocFiles, safeReadDoc, truncate
- 方法/调用入口样本：collect
- 核心链路关键词：Arena
- 风险信号关键词：catch {, path, join(

### 36. `arena/providers/git.ts`

- 行数：186
- SHA1：`b136040fdc103e46ce3ad6616e779ca37147edaf`
- 导出：gitProvider
- 类：（无）
- 函数：git, sanitizeRef, clusterByDirectory
- 方法/调用入口样本：collect
- 核心链路关键词：Arena
- 风险信号关键词：catch {, path, join(, exec, timeout

### 37. `arena/providers/index.ts`

- 行数：162
- SHA1：`0964b23846d99b34c4df2cfafb1ee5d6ab852d1e`
- 导出：CollectEvidenceOptions, collectEvidence
- 类：（无）
- 函数：collectEvidence, runProviderWithTimeout
- 方法/调用入口样本：clearTimeout, resolve, cleanup
- 核心链路关键词：Arena
- 风险信号关键词：catch (, any, join(, timeout, abort

### 38. `arena/providers/none.ts`

- 行数：15
- SHA1：`f78c49a62061576b5515f98a156e23c25d0494de`
- 导出：noneProvider
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：collect
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 39. `arena/providers/repo.ts`

- 行数：265
- SHA1：`bcebfc9476d543b9e5ed7ef3a4106f3dec1b8385`
- 导出：repoProvider, truncate
- 类：（无）
- 函数：buildTree, walkTree, collectEntryFiles, safeReadFile, truncate, safeGrep, gitLog, extractSearchHints
- 方法/调用入口样本：collect
- 核心链路关键词：Arena
- 风险信号关键词：catch {, catch (, path, join(, exec, permission, denied, blocked, timeout, silent

### 40. `arena/render/session.ts`

- 行数：223
- SHA1：`090f6d05e2164cba0bb6a5c78680822bbbe66af2`
- 导出：formatArenaResultForSession
- 类：（无）
- 函数：formatArenaResultForSession, formatRoadmapPhase, formatPhaseDetail, getOrderedConsensusSections, dedupeFindingKinds
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：join(

### 41. `arena/render/terminal.ts`

- 行数：365
- SHA1：`a732a67b57085d001d218a6d6f121ea53ce70474`
- 导出：OutputSink, formatArenaResult, printArenaResult, createProgressRenderer, renderProgress
- 类：（无）
- 函数：formatArenaResult, printArenaResult, formatConsensusSection, countFindings, formatRoadmapSection, formatRoadmapDetailsSection, getOrderedConsensusSections, dedupeFindingKinds, createProgressRenderer, renderProgress
- 方法/调用入口样本：return, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink, sink
- 核心链路关键词：Arena
- 风险信号关键词：join(

### 42. `arena/strategies/discussion.ts`

- 行数：245
- SHA1：`7dc34504e88b09e3791683de41054f08938b9a3f`
- 导出：DiscussionStrategy
- 类：DiscussionStrategy
- 函数：（无）
- 方法/调用入口样本：researchSystemPrompt, return, researchUserPrompt, return, parseResearchResponse, crossReviewSystemPrompt, return, crossReviewUserPrompt, return, parseCrossReviewResponse, consensusSystemPrompt, return, consensusUserPrompt, return, parseConsensusResponse, preferredFindingKinds, verificationReviewUserPrompt, return, parseVerificationReviewResponse, debateTurnUserPrompt
- 核心链路关键词：Arena
- 风险信号关键词：any, path, join(

### 43. `arena/strategies/index.ts`

- 行数：34
- SHA1：`5c464a1055f9769636aceddc99555aaaec6097fd`
- 导出：getStrategy, getStrategyForPlan
- 类：（无）
- 函数：getStrategy, getStrategyForPlan
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 44. `arena/strategies/language-wrapper.ts`

- 行数：132
- SHA1：`00d491e991fb2a73693b26137490ddcfab1dce42`
- 导出：detectLanguageInstruction, withLanguage
- 类：（无）
- 函数：detectLanguageInstruction, withLanguage
- 方法/调用入口样本：researchSystemPrompt, researchUserPrompt, parseResearchResponse, crossReviewSystemPrompt, crossReviewUserPrompt, parseCrossReviewResponse, consensusSystemPrompt, consensusUserPrompt, parseConsensusResponse, preferredFindingKinds, verificationReviewUserPrompt, return, parseVerificationReviewResponse, return, debateTurnUserPrompt, return, parseDebateTurnResponse, return, adjudicationUserPrompt, return
- 核心链路关键词：Arena
- 风险信号关键词：（无命中）

### 45. `arena/strategies/lens-wrapper.ts`

- 行数：298
- SHA1：`daf207bc3407c86c9197e4d8c382fd4707d2aefd`
- 导出：withLens
- 类：（无）
- 函数：withLens, buildPlanPrompt, formatPlanBrief, buildScenarioNotes, formatEmphasis, formatTargets
- 方法/调用入口样本：researchSystemPrompt, researchUserPrompt, parseResearchResponse, crossReviewSystemPrompt, crossReviewUserPrompt, parseCrossReviewResponse, consensusSystemPrompt, consensusUserPrompt, parseConsensusResponse, preferredFindingKinds, verificationReviewUserPrompt, parseVerificationReviewResponse, return, debateTurnUserPrompt, parseDebateTurnResponse, return, adjudicationUserPrompt, parseAdjudicationResponse, return, claimAwareConsensusUserPrompt
- 核心链路关键词：Arena
- 风险信号关键词：path, join(

### 46. `arena/strategies/planning.ts`

- 行数：353
- SHA1：`b40a2a600b608ac1904834675afd97a8d4cabb72`
- 导出：PlanningStrategy
- 类：PlanningStrategy
- 函数：（无）
- 方法/调用入口样本：researchSystemPrompt, return, researchUserPrompt, return, parseResearchResponse, crossReviewSystemPrompt, return, crossReviewUserPrompt, return, parseCrossReviewResponse, consensusSystemPrompt, return, consensusUserPrompt, return, parseConsensusResponse, preferredFindingKinds, verificationReviewUserPrompt, return, parseVerificationReviewResponse, debateTurnUserPrompt
- 核心链路关键词：Arena
- 风险信号关键词：any, path, join(

### 47. `arena/strategies/review.ts`

- 行数：273
- SHA1：`218b51418c0dc9fe87d4d7c7bbcdd0a8d5de23db`
- 导出：ReviewStrategy
- 类：ReviewStrategy
- 函数：（无）
- 方法/调用入口样本：researchSystemPrompt, return, researchUserPrompt, return, parseResearchResponse, crossReviewSystemPrompt, return, crossReviewUserPrompt, return, parseCrossReviewResponse, consensusSystemPrompt, return, consensusUserPrompt, return, parseConsensusResponse, preferredFindingKinds, verificationReviewUserPrompt, return, parseVerificationReviewResponse, debateTurnUserPrompt
- 核心链路关键词：Arena
- 风险信号关键词：any, path, join(

### 48. `arena/strategies/utils.ts`

- 行数：748
- SHA1：`e8f6105be21dacff138cb7aafa99aa059821841e`
- 导出：extractJSON, extractJSONArray, formatBaseContext, formatReports, formatFindingReviews, parseReport, parseReviews, parseConsensus, formatClaimsForReview, formatDebateHistory, formatClaimSummaryForConsensus, formatDigestForPrompt, parseChallenges, parseDebateTurn, parseAdjudication, parseDetailExpansion
- 类：（无）
- 函数：asString, sanitizeForPrompt, extractJSON, extractJSONArray, firstBalancedArray, formatBaseContext, formatReports, formatFindingReviews, parseReport, tryParseReportXml, extractTag, parseAttrs, decodeXmlText, parseFinding, validateFindingKind, extractFindingsFromFreeText, classifyFindingKind, extractFilePaths, parseReviews, parseReview
- 方法/调用入口样本：return
- 核心链路关键词：Arena
- 风险信号关键词：throw new Error, catch {, catch (, any, path, join(

### 49. `arena/tools/selector.ts`

- 行数：70
- SHA1：`7f69fff624abe86e320d99c5086ec50f475c277c`
- 导出：selectTools, hasTools
- 类：（无）
- 函数：selectTools, hasTools
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：any

### 50. `arena/transitions.ts`

- 行数：114
- SHA1：`f80fd9c0b3d3d36f4791d116654c2b6b5db37a5e`
- 导出：transitionClaim, resolveClaimStatus, markUnderReview, applyReviewResult, markUnresolved, isTerminal, validTransitions
- 类：（无）
- 函数：transitionClaim, resolveClaimStatus, markUnderReview, applyReviewResult, markUnresolved, isTerminal, validTransitions
- 方法/调用入口样本：transitionClaim
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any

### 51. `arena/types.ts`

- 行数：630
- SHA1：`b893d8982549ecb576fe41164d43f6d6f658974d`
- 导出：ArenaMode, ArenaLensName, ArenaLensRef, ArenaLens, ArenaSourceKind, ArenaSourceSpec, ArenaSubject, ArenaOutputShape, ArenaPlan, ArenaArtifact, ArenaToolPack, ArenaContextProvider, ArenaQuickFact, ARENA_MODE_DEFAULTS, ArenaParticipant, ArenaBaseContext, FindingKind, ArenaFinding, ParticipantContextRequest, ParticipantReport
- 类：（无）
- 函数：isStrategyPlanning, isStrategyV2
- 方法/调用入口样本：collect, researchSystemPrompt, researchUserPrompt, parseResearchResponse, crossReviewSystemPrompt, crossReviewUserPrompt, parseCrossReviewResponse, consensusSystemPrompt, consensusUserPrompt, parseConsensusResponse, preferredFindingKinds, verificationReviewUserPrompt, parseVerificationReviewResponse, debateTurnUserPrompt, parseDebateTurnResponse, adjudicationUserPrompt, parseAdjudicationResponse, claimAwareConsensusUserPrompt, mergeReviewUserPrompt, parseMergeReviewResponse
- 核心链路关键词：Arena
- 风险信号关键词：path, exec, timeout

### 52. `automation/cron-expr.ts`

- 行数：186
- SHA1：`dd931dcdf874c53c1fa2d22fc3fda90f2481294f`
- 导出：ParsedCron, isCronExpression, parseCronExpression, nextCronTime
- 类：（无）
- 函数：isCronExpression, parseField, parseCronExpression, getFormatter, wallClockInZone, matches, nextCronTime
- 方法/调用入口样本：return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error

### 53. `automation/index.ts`

- 行数：87
- SHA1：`b8fedcaf90679bcee72e7f1989ef817e88ad717b`
- 导出：StartAutomationDeps, AutomationHandle, startAutomation
- 类：（无）
- 函数：startAutomation
- 方法/调用入口样本：stop, bindCronToRunManager, bindCronToEngine
- 核心链路关键词：RunManager, CronScheduler
- 风险信号关键词：throw new Error, any, path, exec

### 54. `automation/runner.ts`

- 行数：103
- SHA1：`b99a1de40d0174abc71be094c10b843963fb009e`
- 导出：CronRunRequest, CronRunResult, CronRunner, bindCronToEngine, RunSubmitter, bindCronToRunManager
- 类：（无）
- 函数：bindCronToEngine, bindCronToRunManager
- 方法/调用入口样本：submit
- 核心链路关键词：RunManager, EngineRunner, CronScheduler
- 风险信号关键词：catch (, path, exec, permission

### 55. `automation/scheduler.ts`

- 行数：552
- SHA1：`0162d45ed1a559a044533a2ab9437ce4f40809e3`
- 导出：CronPermissionLevel, CronJob, CreateJobOptions, UpdateJobPatch, CronScheduler, cronScheduler
- 类：CronScheduler
- 函数：validateSchedule, parseSchedule
- 方法/调用入口样本：constructor, setExecutionEnabled, setStore, setExecutor, loadJobs, reconcileJobs, nextPersistedId, refreshNextRunForDisplay, persist, persistRunStats, create, validateSchedule, delete, list, get, pause, resume, update, validateSchedule, validateSchedule
- 核心链路关键词：RunManager, CronScheduler
- 风险信号关键词：throw new Error, catch {, any, path, exec, permission, silent

### 56. `automation/store.ts`

- 行数：130
- SHA1：`443cd98a14e3e69136244e0fb77c1d7d7629aa13`
- 导出：defaultCronStorePath, CronStore
- 类：CronStore
- 函数：defaultCronStorePath, sleepSync
- 方法/调用入口样本：constructor, load, release, save, release, loadUnlocked, saveUnlocked, writeFileSync, renameSync, rmSync, acquireStoreLock, sleepSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, path, join(, writeFileSync, renameSync

### 57. `automation/write-policy.ts`

- 行数：107
- SHA1：`001ca9524a204e0b77f491750ec3ec8fb898d8a7`
- 导出：CronPermissionLevel, WritePolicy, resolveWritePolicy, wrapUntrustedInput
- 类：TierApprovalBackend
- 函数：resolveWritePolicy, wrapUntrustedInput
- 方法/调用入口样本：constructor, requestApproval
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, join(, exec, permission, denied

### 58. `automation/write-run.ts`

- 行数：64
- SHA1：`a1d0e24a12e7f5b7be965c044d0ddbdeb0897d44`
- 导出：WriteJobGitOps, RunWriteJobInput, RunWriteJobResult, runWriteJobInWorktree
- 类：（无）
- 函数：runWriteJobInWorktree
- 方法/调用入口样本：createWorktree, hasChanges, openPr, removeWorktree
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path

### 59. `capability-control/index.ts`

- 行数：10
- SHA1：`2fbc09485564dc08123e22844d112fac8c3be2e2`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 60. `capability-control/overlay.ts`

- 行数：81
- SHA1：`d80f1c835ce8fe797f21a8d84ea478c9ac87f4ac`
- 导出：OverrideBucket, applyOverride, bucketForKind, overrideTokenForId, overrideFor, effectiveDisabledList
- 类：（无）
- 函数：applyOverride, bucketForKind, overrideTokenForId, overrideFor, effectiveDisabledList
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 61. `capability-control/project.ts`

- 行数：140
- SHA1：`c3c3d3f6606e9507463ee008d860349a74255622`
- 导出：projectBuiltin, projectMcp, projectSkills, projectPlugins
- 类：（无）
- 函数：projectBuiltin, projectMcp, projectSkills, projectPlugins
- 方法/调用入口样本：（无）
- 核心链路关键词：scanSkills
- 风险信号关键词：（无命中）

### 62. `capability-control/service.ts`

- 行数：179
- SHA1：`6134ada412be8c242f19029d740d0662c75ee207`
- 导出：CapabilityServiceDeps, CapabilityService
- 类：CapabilityService
- 函数：readArray
- 方法/调用入口样本：constructor, list, setEnabled, setOverride, writeUserScope
- 核心链路关键词：ToolRegistry, SettingsManager, scanSkills
- 风险信号关键词：throw new Error, any, path

### 63. `capability-control/types.ts`

- 行数：75
- SHA1：`5312e7866ed3fd2b696c74467042affe01f0905d`
- 导出：CapabilityDescriptor, CapabilityControl, CapabilityNotFoundError, WriteScope, CapabilityOverrideState
- 类：CapabilityNotFoundError
- 函数：（无）
- 方法/调用入口样本：constructor, super
- 核心链路关键词：SettingsManager
- 风险信号关键词：any

### 64. `cli/agent-server-stdio.ts`

- 行数：195
- SHA1：`a884943e1afc6e3a4ee6ecab493407cb7d19eab0`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：installGracefulShutdown
- 核心链路关键词：Engine.run, ToolRegistry, MCPManager, SessionManager, AgentServer, ChatSession, SettingsManager
- 风险信号关键词：TODO, any, exec, spawn, permission, timeout, TODO

### 65. `cli/agent-server-tcp.ts`

- 行数：129
- SHA1：`a8c03d098995370a309f0565974f101d32221ba5`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：listenTcp
- 核心链路关键词：ToolRegistry, MCPManager, SessionManager, RunManager, AgentServer, ChatSession, SettingsManager
- 风险信号关键词：permission

### 66. `cli/graceful-shutdown.ts`

- 行数：51
- SHA1：`1444ef7b98644fc3be086fd81f376eb76291f529`
- 导出：GracefulShutdownOptions, installGracefulShutdown
- 类：（无）
- 函数：installGracefulShutdown
- 方法/调用入口样本：close, on, exit
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {

### 67. `colorizer.ts`

- 行数：36
- SHA1：`d44a0649241c959edd48a40f8b4a7a30c078a0b5`
- 导出：Colorizer, NOOP_COLORIZER
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：dim, bold, red, yellow, green, cyan, white, boldCyan, boldWhite
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 68. `context/compaction.ts`

- 行数：627
- SHA1：`56891d5c8926e78cbdf7b2a4ce5d9106ddfeef47`
- 导出：estimateTokens, adjustIndexToPreserveAPIInvariants, snipCompact, windowCompact, COMPACTABLE_TOOL_NAMES, MicrocompactOptions, microcompact, applyToolResultBudget, truncateToolResult, buildSummarizationPrompt, extractAnchoredSummary, applySummaryCompaction, groupMessagesByApiRound, dropOldestRounds, extractReferencedFilePaths
- 类：（无）
- 函数：estimateTokens, adjustIndexToPreserveAPIInvariants, snipCompact, windowCompact, buildToolUseIdToNameMap, summarizeToolCallArgs, microcompact, applyToolResultBudget, truncateToolResult, buildSummarizationPrompt, extractAnchoredSummary, applySummaryCompaction, groupMessagesByApiRound, dropOldestRounds, extractReferencedFilePaths
- 方法/调用入口样本：return, return, return, return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path, join(

### 69. `context/manager.ts`

- 行数：489
- SHA1：`02aa29d9cc71548ee17679b78fba4712191d293e`
- 导出：ContextManagerConfig, SummarizeFn, CompactStrategy, OnCompactFn, ContextManager
- 类：ContextManager
- 函数：defaultKeepRecent
- 方法/调用入口样本：constructor, setOnCompact, recordActualUsage, estimateTokensHybrid, setSummarizeFn, setTranscriptPath, initReplacementStateFromMessages, manage, manageAsync, persistLargeToolResults, truncateToolResults, shouldReactiveCompact, checkLimits
- 核心链路关键词：ContextManager, Transcript
- 风险信号关键词：catch (, any, path, silent

### 70. `context/token-counter.ts`

- 行数：117
- SHA1：`658ea7caa31efa0734a3db49fac9e353f38a3107`
- 导出：estimateStringTokens, estimateMessagesTokens, ContextUsage, calculateContextUsage
- 类：（无）
- 函数：estimateStringTokens, estimateMessagesTokens, estimateBlockTokens, calculateContextUsage
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 71. `context/tool-result-storage.ts`

- 行数：367
- SHA1：`fd9c5153f5c5eb8b64db98d2576005ed9412479b`
- 导出：DEFAULT_PERSIST_THRESHOLD, PER_MESSAGE_AGGREGATE_CAP, PREVIEW_SIZE, ContentReplacementState, createContentReplacementState, reconstructContentReplacementState, resolveToolResultsDir, applyToolResultPersistence, isPersistedReplacement
- 类：（无）
- 函数：createContentReplacementState, reconstructContentReplacementState, resolveToolResultsDir, ensureDir, persistToFile, buildReplacement, collectCandidates, applyToolResultPersistence, isPersistedReplacement
- 方法/调用入口样本：mkdirSync, ensureDir, writeFileSync, return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, catch (, any, path, join(, writeFileSync

### 72. `cost-tracker.ts`

- 行数：397
- SHA1：`afaf6fb1ed7a61aeee0478bde475f58a2a174339`
- 导出：UsageRecord, CostTracker, SessionCostState, costTracker, installCostTracking
- 类：CostTracker
- 函数：pricing, openRouterPricing, lookupPricing, getCanonicalName, formatCost, formatNumber, formatDuration, installCostTracking
- 方法/调用入口样本：findOpenRouterModel, findOpenRouterModel, record, getTotalTokens, getEstimatedCost, getRequestCount, getSessionDuration, estimateForTokens, return, getCacheTokens, formatSummary, formatCompact, reset, serialize, restore
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, join(

### 73. `cron/cron-runtime.ts`

- 行数：2
- SHA1：`a827a385bcf8c7f121958acc440a3fe707c8bca1`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 74. `cron/cron-store.ts`

- 行数：2
- SHA1：`96b19cfff39bcde3721ff026825c020d7b397968`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 75. `cron/scheduler.ts`

- 行数：7
- SHA1：`23ac7225047e51e691b89ec7d7d119202f3bf196`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 76. `data/openrouter-models.ts`

- 行数：63
- SHA1：`13f5879b3fd0cd8ef6814615f744ac22c4652dfb`
- 导出：OpenRouterModel, setOpenRouterSnapshot, getOpenRouterSnapshot, getOpenRouterModels, findOpenRouterModel, listOpenRouterModelsByVendor
- 类：（无）
- 函数：loadSnapshot, setOpenRouterSnapshot, getOpenRouterSnapshot, getOpenRouterModels, findOpenRouterModel, listOpenRouterModelsByVendor
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 77. `data/openrouter-sync.ts`

- 行数：77
- SHA1：`fcc920cdc0362949e40d2313dac3a40b3bd7d3c4`
- 导出：SyncResult, syncOpenRouterCatalog
- 类：（无）
- 函数：priceToPerMillion, slim, syncOpenRouterCatalog
- 方法/调用入口样本：setOpenRouterSnapshot
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, timeout

### 78. `data/static-catalogs.ts`

- 行数：50
- SHA1：`ece84a66441463db671b03df40530cfe6fe744a4`
- 导出：StaticModel, listStaticModels, hasStaticCatalog
- 类：（无）
- 函数：listStaticModels, hasStaticCatalog
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 79. `engine/cost-store.ts`

- 行数：24
- SHA1：`2441b3edc12cf79b11951317ce90e891e3330de0`
- 导出：CostStateSnapshot, CostStateStore
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：serialize, restore
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 80. `engine/engine.ts`

- 行数：2081
- SHA1：`145ba79e129b3c0ccf68c30a3c6e18ec3e2b7370`
- 导出：EngineConfig, EngineHookConfig, EngineResult, resolveChildLlm, loadAgentDefinitionsForCwd, resolveChildToolScope, Engine
- 类：Engine
- 函数：resolveChildLlm, loadAgentDefinitionsForCwd, resolveChildToolScope
- 方法/调用入口样本：resolveMaxContextTokens, emitHook, registerSettingsHooks, async, constructor, loadPluginHooks, populateModelPoolFromSettings, reloadModelPool, autoPopulatePool, registerCustomTool, setAskUser, isHeadless, run, destStream, defaultSandboxConfig, setCurrentSid, recordSessionStart, async, recordSessionEnd, onStream
- 核心链路关键词：Engine.run, TurnLoop, createLLMClient, ToolExecutor, PermissionClassifier, ToolRegistry, MCPManager, ContextManager, PromptComposer, SessionManager, Transcript, AgentServer, ChatSession, SettingsManager, HookRegistry, Arena, saveState, turn_complete, session_started
- 风险信号关键词：TODO, catch {, catch (, any, path, join(, writeFileSync, renameSync, exec, spawn, permission, bypass, denied, timeout, abort, fire-and-forget, silent, TODO

### 81. `engine/image-compression.ts`

- 行数：238
- SHA1：`cac77337ec2bee15764b230d18e029aab4571391`
- 导出：ImageCompressionResult, ImageCompressor, setEngineImageCompressor, resetEngineImageCompressor, tryCompressImages
- 类：（无）
- 函数：setEngineImageCompressor, resetEngineImageCompressor, resolveJimpCompressor, tryCompressImages
- 方法/调用入口样本：compress, compress, compress
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, path

### 82. `engine/image-policy.ts`

- 行数：253
- SHA1：`9ef1b2ec04c1d2994923c68012985f4065b3c5cd`
- 导出：IMAGE_LIMITS, IMAGE_TARGETS, byteLengthFromBase64, ImagePolicyVerdict, DropOversizedResult, dropOversizedImages, enforceImagePolicy
- 类：（无）
- 函数：byteLengthFromBase64, fmtMB, dropOversizedImages, enforceImagePolicy
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path, join(, silent

### 83. `engine/model-facade.ts`

- 行数：251
- SHA1：`a31d72c42fda5b62a955693018d4405c51bf2c7e`
- 导出：ModelFacade
- 类：ModelFacade
- 函数：nextReqId
- 方法/调用入口样本：constructor, call, recordLLMRequest, onStream, onStream, onStream, recordLLMError, recordLLMResponse, callWithoutStreaming, recordLLMRequest, recordLLMError, recordLLMResponse, recordUsage, addAPIDuration, addInputTokens, addOutputTokens, addToModelUsage, recordResponse, getUsage
- 核心链路关键词：Transcript
- 风险信号关键词：catch (, path

### 84. `engine/parse-task.ts`

- 行数：173
- SHA1：`e314f6c537bee2e3cc7f802eddb1c59eeac2514b`
- 导出：ParsedImage, ParsedTask, ImageParseError, parseTaskWithImages
- 类：ImageParseError
- 函数：unescapeAttr, parseAttrs, parseDataUrl, parseTaskWithImages
- 方法/调用入口样本：constructor, super
- 核心链路关键词：（无直接命中）
- 风险信号关键词：exec, silent

### 85. `engine/patch-orphaned-tools.ts`

- 行数：111
- SHA1：`b939a4dcb15b42f018ad8ca373cd76b27dae6972`
- 导出：PatchOrphanedSummary, patchOrphanedToolUses
- 类：（无）
- 函数：patchOrphanedToolUses
- 方法/调用入口样本：（无）
- 核心链路关键词：TurnLoop
- 风险信号关键词：any, exec

### 86. `engine/query.ts`

- 行数：169
- SHA1：`d5f3012fbf47564cd8e7f2ff32bcf382487ded19`
- 导出：QueryParams, QueryDeps, QueryResult
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：resolveWait, resolveWait, resolveWait
- 核心链路关键词：TurnLoop
- 风险信号关键词：（无命中）

### 87. `engine/reactive-threshold.ts`

- 行数：22
- SHA1：`92f5b1b40b15451d9f413632601674ccad5eaf07`
- 导出：crossedReactiveThreshold
- 类：（无）
- 函数：crossedReactiveThreshold
- 方法/调用入口样本：（无）
- 核心链路关键词：ContextManager
- 风险信号关键词：（无命中）

### 88. `engine/runtime.ts`

- 行数：81
- SHA1：`1168ae4cc7f468b7780d4430b14bfda490a6ca3a`
- 导出：EngineRuntimeOptions, EngineRuntime
- 类：EngineRuntime
- 函数：（无）
- 方法/调用入口样本：constructor, resolveSandbox, close
- 核心链路关键词：ToolRegistry, MCPManager, SettingsManager
- 风险信号关键词：silent

### 89. `engine/session-title.ts`

- 行数：49
- SHA1：`57720171fa821f13783b03a3c9236e7b8951708b`
- 导出：buildSessionTitle
- 类：（无）
- 函数：clean, buildSessionTitle
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any

### 90. `engine/streaming-tool-queue.ts`

- 行数：71
- SHA1：`bfded1e4222ec3b6d90e8f37aad960ff8c883f91`
- 导出：StreamingToolQueue
- 类：StreamingToolQueue
- 函数：（无）
- 方法/调用入口样本：constructor, enqueue, drain
- 核心链路关键词：ToolExecutor
- 风险信号关键词：throw new Error, exec

### 91. `engine/token-budget.ts`

- 行数：60
- SHA1：`21d2a3d0f3ee3f7d9f73379a9a9bdeaf62d46add`
- 导出：BudgetTracker, createBudgetTracker, BudgetDecision, checkTokenBudget
- 类：（无）
- 函数：createBudgetTracker, checkTokenBudget
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 92. `engine/tool-summary.ts`

- 行数：46
- SHA1：`eaefffe9f5143cd7826f30e4a2871bfa2e24b5e3`
- 导出：SummarizeFn, generateToolUseSummary
- 类：（无）
- 函数：generateToolUseSummary
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, join(, exec, fire-and-forget

### 93. `engine/turn-loop.ts`

- 行数：837
- SHA1：`2b04a717f9dca24fcacee515ac8101fdb5f42d4a`
- 导出：TurnLoopConfig, CtxOverheadStore, TurnLoopDeps, TurnLoopResult, TurnLoop
- 类：TurnLoop
- 函数：（无）
- 方法/调用入口样本：get, set, constructor, inner, emitHook, emitCtxFromMessages, emitCtxFromUsage, run, isTruncatedStop, import, generateToolUseSummary, callModelWithFallback, patchOrphanedToolUses
- 核心链路关键词：TurnLoop, ToolExecutor, ContextManager, Transcript, HookRegistry, saveState, turn_complete
- 风险信号关键词：catch {, catch (, any, path, join(, exec, spawn, permission, blocked, abort, silent

### 94. `engine/turn-state.ts`

- 行数：31
- SHA1：`730d21974215669944b3afd377eac96f22d595cb`
- 导出：TurnState, initialTurnState, newTurnId
- 类：（无）
- 函数：initialTurnState, newTurnId
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 95. `exceptions.ts`

- 行数：148
- SHA1：`275827c4e41a4ac1fc9178fb7e0713a973932508`
- 导出：FrameworkError, LLMError, LLMRateLimitError, ContextLimitError, ToolError, ToolNotFoundError, ToolExecutionError, ToolTimeoutError, PermissionDeniedError, SessionError, TranscriptError, ConfigError, SandboxUnavailableError
- 类：FrameworkError, LLMError, LLMRateLimitError, ContextLimitError, ToolError, ToolNotFoundError, ToolExecutionError, ToolTimeoutError, PermissionDeniedError, SessionError, TranscriptError, ConfigError, SandboxUnavailableError
- 函数：（无）
- 方法/调用入口样本：constructor, super, constructor, super, constructor, super, constructor, super, constructor, super, constructor, super, constructor, super, constructor, super, constructor, super, constructor, super
- 核心链路关键词：Transcript
- 风险信号关键词：exec, denied, timeout, silent

### 96. `git/parse-log.ts`

- 行数：28
- SHA1：`cab517f9dc14f86e8c6fb35b602d29acb2dfb0fc`
- 导出：GitLogEntry, parseGitLog
- 类：（无）
- 函数：parseGitLog
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 97. `git/utils.ts`

- 行数：150
- SHA1：`f72cd926362813b8271ae4e4833c5c7ec87a69f1`
- 导出：GitStatusEntry, isGitRepo, getCurrentBranch, getGitStatus, getGitDiff, getGitDiffStat, getGitLog, getRemoteUrl, gitAdd, gitCommit, gitListBranches, gitCheckout, ghAvailable, ghPrComments
- 类：（无）
- 函数：git, gh, isGitRepo, getCurrentBranch, getGitStatus, getGitDiff, getGitDiffStat, getGitLog, getRemoteUrl, gitAdd, gitCommit, gitListBranches, gitCheckout, ghAvailable, ghPrComments
- 方法/调用入口样本：git, execFileSync, execFileSync, execFileSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, catch {, path, exec, timeout

### 98. `git/worktree.ts`

- 行数：179
- SHA1：`9c80987b56e17f59bdc36c330b2cf1b88f2687d7`
- 导出：WorktreeSession, validateWorktreeSlug, findGitRoot, createWorktree, removeWorktree, listWorktrees
- 类：（无）
- 函数：validateWorktreeSlug, findGitRoot, createWorktree, removeWorktree, listWorktrees, symlinkLargeDirectories
- 方法/调用入口样本：validateWorktreeSlug, execFileSync, symlinkLargeDirectories, execFileSync, execFileSync, symlinkSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, catch {, path, join(, exec, bypass, timeout, silent

### 99. `hooks/events.ts`

- 行数：156
- SHA1：`648e421057a18a774da9b7a8a1696cb1e1f6e6dd`
- 导出：HookEventName, HookContext, HookResult
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：Engine.run, TurnLoop, ContextManager
- 风险信号关键词：path, exec, spawn, permission, silent

### 100. `hooks/goal-stop-hook.ts`

- 行数：133
- SHA1：`ab419eab5025277ca2e937be90a7b10020ee722f`
- 导出：GoalJudgeLLM, GoalStopHookOptions, createGoalStopHook
- 类：（无）
- 函数：extractJson, createGoalStopHook
- 方法/调用入口样本：createMessage
- 核心链路关键词：TurnLoop
- 风险信号关键词：catch {, catch (

### 101. `hooks/hook-output.ts`

- 行数：73
- SHA1：`09fbd9446456ab4a8166120ef9056724048ff90a`
- 导出：MAX_HOOK_OUTPUT_BYTES, validateHookResult
- 类：（无）
- 函数：validateHookResult
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, spawn, silent

### 102. `hooks/inject.ts`

- 行数：30
- SHA1：`c2fd519ee4112be5d82e6c47a827539abbe19818`
- 导出：wrapHookMessages
- 类：（无）
- 函数：wrapHookMessages
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：join(

### 103. `hooks/registry.ts`

- 行数：145
- SHA1：`aaeb4aff67cc21102ce8beebe14b5825f0744ff0`
- 导出：HookHandler, HookRegistry
- 类：HookRegistry
- 函数：stricterDecision
- 方法/调用入口样本：register, unregister, emit, hasHooks, return, clear, listHooks, listEvents, countHandlers
- 核心链路关键词：HookRegistry
- 风险信号关键词：catch (, any, exec, permission

### 104. `hooks/shell-runner.ts`

- 行数：250
- SHA1：`aabafb3b036f0bffdc3bf40613157e5dba5eb512`
- 导出：runShellHook, shellHookMatches
- 类：（无）
- 函数：runShellHook, shellHookMatches
- 方法/调用入口样本：resolve, resolve, setTimeout, settle, clearTimeout, settle, clearTimeout, settle, settle, settle, settle, settle, settle, settle, settle
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, catch (, any, exec, spawn, denied, timeout

### 105. `index.ts`

- 行数：665
- SHA1：`a03dc68c3bcf9c66d794ec5c4445db441809e989`
- 导出：VERSION
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：createLLMClient, ToolExecutor, PermissionClassifier, ToolRegistry, MCPManager, ContextManager, PromptComposer, SessionManager, Transcript, RunManager, EngineRunner, AgentServer, AgentClient, ChatSession, SettingsManager, HookRegistry, scanSkills, CronScheduler, Arena
- 风险信号关键词：exec, spawn, permission

### 106. `llm/api-key-sanitize.ts`

- 行数：101
- SHA1：`ed6d85048cd732b0222ac3cfdcec86b5b48f889d`
- 导出：SanitizeResult, sanitizeApiKey, hasNonAsciiPrintable
- 类：（无）
- 函数：sanitizeApiKey, hasNonAsciiPrintable
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any

### 107. `llm/capabilities/index.ts`

- 行数：56
- SHA1：`bd6d7bb3327dc844e8a8e5745cce78e079a2b557`
- 导出：capabilitiesFor
- 类：（无）
- 函数：capabilitiesFor
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 108. `llm/capabilities/rules.ts`

- 行数：231
- SHA1：`f95b61866e7b6863ce0ae93b22c2ee86b7c710d7`
- 导出：RULES
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：abort

### 109. `llm/capabilities/types.ts`

- 行数：136
- SHA1：`575798169f292cb2592369d545024c068be06627`
- 导出：ReasoningEffort, ThinkingSwitch, ReasoningShape, EchoReasoning, ParallelToolCallsShape, StreamUsageShape, Capability, DEFAULT_CAPABILITY, CapabilityRule
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：silent

### 110. `llm/clamp-max-tokens.ts`

- 行数：18
- SHA1：`559007f893f4941ae899dec97bb50fbff9757254`
- 导出：clampMaxTokens
- 类：（无）
- 函数：clampMaxTokens
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 111. `llm/client-base.ts`

- 行数：209
- SHA1：`7487a4324a08caa5eb959e85b131041d18c3efe7`
- 导出：isClientError, isAbortError
- 类：（无）
- 函数：isClientError, isAbortError
- 方法/调用入口样本：constructor, recordUsage, getUsage
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, path, timeout, abort

### 112. `llm/client-factory.ts`

- 行数：45
- SHA1：`696c9db0cbc68b694d83f8ee4a6061d60229c260`
- 导出：registerProvider, createLLMClient
- 类：（无）
- 函数：registerProvider, createLLMClient
- 方法/调用入口样本：registerProvider, registerProvider
- 核心链路关键词：createLLMClient
- 风险信号关键词：join(

### 113. `llm/model-cache.ts`

- 行数：63
- SHA1：`8d231d7a732e69b486b7e86032e33cd9ce824aa4`
- 导出：CachedModel, ModelCacheFile, readCache, writeCache, isStale, defaultCacheDir
- 类：（无）
- 函数：readCache, writeCache, isStale, defaultCacheDir
- 方法/调用入口样本：writeFileSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, writeFileSync

### 114. `llm/model-fetcher.ts`

- 行数：348
- SHA1：`deb45df51dd20ebeba2f1a57167835e36adeced2`
- 导出：FetcherProvider, FetchOptions, FetchResult, fetchModelList
- 类：（无）
- 函数：fetchModelList, enrichFromStaticCatalog, enrichFromOpenRouterSnapshot, sortByRecency, normalize, loadOpenRouterSnapshot, errorResult, joinUrl
- 方法/调用入口样本：return, return, return, return, readFileSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, any, path, join(, timeout

### 115. `llm/model-pool.ts`

- 行数：283
- SHA1：`a67d23181a81dca81deda1a7e65f08330694e41a`
- 导出：ModelEntry, ModelPool
- 类：ModelPool
- 函数：lookupBuiltinContextWindow
- 方法/调用入口样本：setProviderCatalog, setCacheDir, reloadCachedContextWindows, resolveContextWindow, constructor, register, withBuiltinDefaults, get, getActiveKey, list, has, toLLMConfig, kindToClientProvider, resolveLLMConfig
- 核心链路关键词：TurnLoop, Arena
- 风险信号关键词：throw new Error, path, join(, timeout

### 116. `llm/provider-catalog.ts`

- 行数：71
- SHA1：`1415a5200833cb5014fd0aacf5cfe710b38f3f8a`
- 导出：ProviderConfig, ProviderCatalog
- 类：ProviderCatalog
- 函数：（无）
- 方法/调用入口样本：constructor, list, get, has, add, update, remove, deriveKey
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, join(

### 117. `llm/provider-kinds.ts`

- 行数：167
- SHA1：`3934d0e96d3ebe433ff1d2a1db0bd6df3ba29fad`
- 导出：ProviderKindName, ProviderProtocol, ProviderKindMeta, PROVIDER_KINDS, getKindMeta
- 类：（无）
- 函数：getKindMeta
- 方法/调用入口样本：return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path

### 118. `llm/providers/anthropic.ts`

- 行数：326
- SHA1：`5beb45ec406d1c207fd1f71439d4bac0949c6639`
- 导出：AnthropicClient
- 类：AnthropicClient
- 函数：（无）
- 方法/调用入口样本：constructor, super, initClient, createMessage, nonStreamMessage, streamMessage, processResponse, buildMessages, convertTools, handleApiError
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, any, as any, path, timeout, abort

### 119. `llm/providers/openai.ts`

- 行数：829
- SHA1：`8a3ea0559d1c853dca8645b1999070d1f729ebd9`
- 导出：runStreamWithWatchdog, OpenAIClient
- 类：OpenAIClient
- 函数：runStreamWithWatchdog, extractReasoningContent, mapImageDetailToOpenAI
- 方法/调用入口样本：reject, constructor, super, initClient, createMessage, buildRequestBody, nonStreamMessage, streamMessage, processChoice, buildMessages, convertTools, handleApiError
- 核心链路关键词：Engine.run
- 风险信号关键词：catch {, catch (, any, as any, path, join(, timeout, abort, silent

### 120. `llm/retry.ts`

- 行数：18
- SHA1：`346752936873d09a63cc786ab14da62f51e15857`
- 导出：isRetryable
- 类：（无）
- 函数：isRetryable
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：timeout, abort

### 121. `llm/stop-reason.ts`

- 行数：22
- SHA1：`b9374c74e9b263f8203a49369f2f8fcfe3569023`
- 导出：isTruncatedStop
- 类：（无）
- 函数：isTruncatedStop
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 122. `llm/stream-watchdog.ts`

- 行数：97
- SHA1：`e943821ad12a9033e81f2ed9b88b6556394b1ba8`
- 导出：StreamWatchdogOptions, StreamWatchdog, StreamIdleTimeoutError, createStreamWatchdog, STREAM_WATCHDOG_CONFIG
- 类：StreamIdleTimeoutError
- 函数：createStreamWatchdog, arm, clear
- 方法/调用入口样本：reset, dispose, constructor, super, clearTimeout, clearTimeout, arm, reset, clear, arm, dispose, clear, parseInt, parseInt
- 核心链路关键词：（无直接命中）
- 风险信号关键词：timeout, abort

### 123. `llm/strip-vision.ts`

- 行数：66
- SHA1：`e46a98d1a8bc8c54f5dc2a89e123bea97b035f50`
- 导出：VISION_PLACEHOLDER, stripVisionFromHistory
- 类：（无）
- 函数：stripVisionFromHistory
- 方法/调用入口样本：（无）
- 核心链路关键词：Engine.run
- 风险信号关键词：path, silent

### 124. `llm/token-counter.ts`

- 行数：41
- SHA1：`0c865cc9df59ff49999772dc7157982611a0cb99`
- 导出：countTokens
- 类：（无）
- 函数：getEncoder, countTokens
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 125. `llm/types.ts`

- 行数：40
- SHA1：`fed1deb921fb336a8c54fab9117f58757c38270c`
- 导出：CreateMessageOptions, LLMUsageTracker
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 126. `logging/logger.ts`

- 行数：454
- SHA1：`b0a338f6d3c7fff37285f894436cd0816e36d537`
- 导出：LogLevel, setLogsDir, setCurrentSid, getCurrentSid, runWithSid, enterSid, getInMemoryErrors, ErrorLogSink, attachErrorLogSink, LogContext, LogSpan, logger, getLogsDir, getRecentLogs, rotateLogs, _resetLoggerStateForTesting
- 类：Logger
- 函数：defaultLogsDir, logsDir, setLogsDir, routeBucket, isLocalDev, resolveDefaultLevel, resolveCategoryFilter, setCurrentSid, getCurrentSid, runWithSid, enterSid, getInMemoryErrors, attachErrorLogSink, getLogsDir, getRecentLogs, rotateLogs, _resetLoggerStateForTesting
- 方法/调用入口样本：constructor, child, setSid, setCurrentSid, getSid, debug, info, warn, error, recordError, write, appendFileSync, getMinLevel, isCategoryActive, span, end, fail, unlinkSync
- 核心链路关键词：Engine.run
- 风险信号关键词：catch {, any, path, join(, appendFileSync, exec, spawn, permission, silent

### 127. `logging/sanitize-messages.ts`

- 行数：273
- SHA1：`135cae7334b58d4685e941459313a35c114b5d24`
- 导出：sanitizeContent, sanitizeMessages, redactSecrets, sanitizeTaskString
- 类：（无）
- 函数：isImageBlock, isImageUrlPart, sanitizeImageBlock, sanitizeImageUrlPart, sanitizeContent, sanitizeMessages, isSecretKey, redactSecretsInString, redactSecrets, sanitizeTaskString
- 方法/调用入口样本：return, return
- 核心链路关键词：Transcript
- 风险信号关键词：any, path

### 128. `logging/session-recorder.ts`

- 行数：365
- SHA1：`2129a5052c574974003b34c15686ee6db0b42f2e`
- 导出：isVerboseRecorderEnabled, getVerboseLogDir, recordSessionStart, RecordLLMRequest, recordLLMRequest, RecordLLMResponse, recordLLMResponse, recordLLMError, recordToolCall, recordToolResult, recordEvent, recordUIEvent, recordSessionEnd
- 类：（无）
- 函数：clip, isLocalDev, resolveLogDir, redactArgv, todayStr, rotateOnce, ensureState, write, isVerboseRecorderEnabled, getVerboseLogDir, recordSessionStart, recordLLMRequest, recordLLMResponse, recordLLMError, recordToolCall, recordToolResult, recordEvent, recordUIEvent, recordSessionEnd
- 方法/调用入口样本：rmSync, rotateOnce, appendFileSync, appendFileSync, write, write, write, write, write, write, write, write, write
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, path, join(, appendFileSync, exec, permission

### 129. `lsp/client.ts`

- 行数：211
- SHA1：`6867ee0faccbc0af4cee450c9025dd9678cca2cd`
- 导出：LSPRequest, LSPResponse, LSPNotification, LSPClient
- 类：LSPClient
- 函数：（无）
- 方法/调用入口样本：constructor, super, start, initialize, request, reject, notify, shutdown, reject, handleData, reject, resolve, rejectAll, reject
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, catch {, spawn

### 130. `lsp/manager.ts`

- 行数：148
- SHA1：`58e9da501b4a74335098ef6612fa7b9e2188c038`
- 导出：LSPServerManager, initializeLSPManager, getLSPManager
- 类：LSPServerManager
- 函数：initializeLSPManager, getLSPManager
- 方法/调用入口样本：constructor, getClient, startServer, isConnected, listServers, shutdownAll, isCommandAvailable, execSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, catch (, any, path, exec, timeout

### 131. `lsp/root-path.ts`

- 行数：13
- SHA1：`59321cafe1a99421852cb8edb32c398fd0ed649f`
- 导出：rootUriToPath
- 类：（无）
- 函数：rootUriToPath
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path

### 132. `lsp/servers.ts`

- 行数：71
- SHA1：`26f3b0350137b6732ef115fa49748832ce2bc9bd`
- 导出：LSPServerConfig, BUILTIN_LSP_SERVERS, detectLSPServer
- 类：（无）
- 函数：detectLSPServer
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 133. `migrate-models.ts`

- 行数：228
- SHA1：`841de031a4e5d30d3bf037b247ecdd34554fbc14`
- 导出：MigrationInput, MigrationOutput, migrateModels
- 类：（无）
- 函数：inferKind, makeFingerprint, deriveKey, deriveProviderModelKey, migrateModels
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path

### 134. `onboarding.ts`

- 行数：727
- SHA1：`abc77577ae74cf339340f38ae44d2bbfc35a9973`
- 导出：OnboardingResult, ProviderDef, PROVIDERS, resolveProviderModels, DetectedEnvKey, detectEnvKeys, maskKey, detectProviderFromApiKey, validateApiKey, resolveApiKey, findSavedKeyForProvider, loadSavedModelsForProvider, hasApiKey, resolveMaxOutput, resolveContextWindow, deriveModelPoolKey, buildModelPool, modelDisplayName, saveSettings, appendOnboardingResult
- 类：（无）
- 函数：buildOpenRouterModelList, resolveProviderModels, detectEnvKeys, maskKey, detectProviderFromApiKey, validateApiKey, resolveApiKey, findSavedKeyForProvider, loadSavedModelsForProvider, hasApiKey, resolveMaxOutput, resolveContextWindow, deriveModelPoolKey, buildModelPool, modelDisplayName, saveSettings, appendOnboardingResult, saveArenaSettingsByKeys
- 方法/调用入口样本：mkdirSync, writeFileSync, mkdirSync, writeFileSync, renameSync, writeFileSync, rmSync, writeFileSync
- 核心链路关键词：Arena
- 风险信号关键词：catch {, any, as any, path, join(, writeFileSync, renameSync, silent

### 135. `plugins/gitOps.ts`

- 行数：94
- SHA1：`b7079ac2973769ca770a1bc7ed6470f223596efd`
- 导出：GitResult, nonInteractiveGitEnv, gitClone, gitRevParseHead, gitFetchAndReset, githubRepoToCloneUrl
- 类：（无）
- 函数：nonInteractiveGitEnv, runGit, gitClone, gitRevParseHead, gitFetchAndReset, githubRepoToCloneUrl
- 方法/调用入口样本：（无）
- 核心链路关键词：safeSpawn
- 风险信号关键词：join(, spawn, permission, timeout

### 136. `plugins/installedPlugins.ts`

- 行数：63
- SHA1：`4dd0e51f58031bd0268d72fe60bef482b438c38a`
- 导出：installedPluginsPath, readInstalledPlugins, writeInstalledPlugins, appendInstallEntry, removeInstallEntries, pluginInstallKey
- 类：（无）
- 函数：userHome, installedPluginsPath, readInstalledPlugins, writeInstalledPlugins, appendInstallEntry, removeInstallEntries, pluginInstallKey
- 方法/调用入口样本：mkdirSync, writeFileSync, writeInstalledPlugins, writeInstalledPlugins
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, writeFileSync

### 137. `plugins/installer/codex/convertAgents.ts`

- 行数：63
- SHA1：`c98451f5d5cf09c7e8c12a4a9c27f8598608b454`
- 导出：convertCodexAgentToml
- 类：（无）
- 函数：convertCodexAgentToml
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, exec

### 138. `plugins/installer/codex/convertMcp.ts`

- 行数：39
- SHA1：`ba182984ece1f683dd31ecef83131eb24d5620cc`
- 导出：resolveCodexMcpServers
- 类：（无）
- 函数：resolveCodexMcpServers
- 方法/调用入口样本：return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, path, join(

### 139. `plugins/installer/codex/convertSkills.ts`

- 行数：26
- SHA1：`271c1bae6506910387da038366b7d445e436a60b`
- 导出：copyCodexSkills
- 类：（无）
- 函数：copyCodexSkills
- 方法/调用入口样本：cpSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, join(

### 140. `plugins/installer/detectFormat.ts`

- 行数：7
- SHA1：`f2cb9bd8036a7a4d633cc0c7a1253f7001661e29`
- 导出：detectPluginFormat
- 类：（无）
- 函数：detectPluginFormat
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, join(

### 141. `plugins/installer/install.ts`

- 行数：105
- SHA1：`0b191a678e563d0c64a1d23210b51d7e47d6e0e7`
- 导出：installPluginFromPath
- 类：（无）
- 函数：installPluginFromPath, convertAgentsInto
- 方法/调用入口样本：assertSafePluginName, mkdirSync, rmSync, mkdirSync, cpSync, copyCodexSkills, convertAgentsInto, writeFileSync, writeFileSync, renameSync, appendInstallEntry, rmSync, mkdirSync, writeFileSync, walk
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, path, join(, writeFileSync, renameSync

### 142. `plugins/installer/installFromSource.ts`

- 行数：55
- SHA1：`180c4509a0843fbec386f95eb2086372e8af6b25`
- 导出：installPluginFromSource
- 类：（无）
- 函数：installPluginFromSource
- 方法/调用入口样本：writeFileSync, rmSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path, join(, writeFileSync

### 143. `plugins/installer/list.ts`

- 行数：37
- SHA1：`8f00850abd0720e7da330ed64961dd682a80f98c`
- 导出：PluginListRow, listInstalledPlugins
- 类：（无）
- 函数：listInstalledPlugins
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(

### 144. `plugins/installer/loadPluginAgents.ts`

- 行数：24
- SHA1：`d15dfe26157c6814fe5ec8dc9ca52b5e5e5bbcee`
- 导出：pluginAgentDirs
- 类：（无）
- 函数：pluginNameFromKey, pluginAgentDirs
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, join(

### 145. `plugins/installer/loadPluginMcp.ts`

- 行数：78
- SHA1：`9eae8aadbb0914c23f8b67eb28e9fbd77f2a489d`
- 导出：mergePluginMcpServers
- 类：（无）
- 函数：pluginNameFromKey, readPluginMcp, mergePluginMcpServers
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(

### 146. `plugins/installer/parseSource.ts`

- 行数：102
- SHA1：`87c1ae0748efd5ae562834261a7f0f659a92d481`
- 导出：ParsedSource, parseSource
- 类：（无）
- 函数：isSshUrl, isRemote, repoNameFromUrl, lastSegment, parseSource
- 方法/调用入口样本：return, isSshUrl
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, exec

### 147. `plugins/installer/paths.ts`

- 行数：30
- SHA1：`037a59ca15082d8a5482df23d32b6d7a9c24f679`
- 导出：assertSafePluginName, pluginsRoot, pluginInstallDir, pluginMetaPath
- 类：（无）
- 函数：userHome, assertSafePluginName, pluginsRoot, pluginInstallDir, pluginMetaPath
- 方法/调用入口样本：assertSafePluginName
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, join(

### 148. `plugins/installer/types.ts`

- 行数：34
- SHA1：`c4896453460d4a8af0c26ea909ced56b3b8ba09a`
- 导出：CodexPluginManifest, CodexPluginManifest, CSMeta, CSMeta, PluginInstallError
- 类：PluginInstallError
- 函数：（无）
- 方法/调用入口样本：constructor, super
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path

### 149. `plugins/installer/uninstall.ts`

- 行数：15
- SHA1：`7268bde5f34a3364ca1cb7ca0c02221db35fd408`
- 导出：uninstallPluginByName
- 类：（无）
- 函数：uninstallPluginByName
- 方法/调用入口样本：assertSafePluginName, rmSync, removeInstallEntries
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path

### 150. `plugins/installer/update.ts`

- 行数：82
- SHA1：`c29fbb4544e958f197b30c49a0360a0bbafa9b6c`
- 导出：UpdateResult, updatePluginByName
- 类：（无）
- 函数：updatePluginByName
- 方法/调用入口样本：uninstallPluginByName, uninstallPluginByName, installPluginFromPath
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, path, join(, silent

### 151. `plugins/knownMarketplaces.ts`

- 行数：51
- SHA1：`595ca3a4dcab0c4aa82a59f4e692f5af398c4352`
- 导出：knownMarketplacesPath, readKnownMarketplaces, writeKnownMarketplaces, upsertKnownMarketplace, removeKnownMarketplace
- 类：（无）
- 函数：userHome, knownMarketplacesPath, readKnownMarketplaces, writeKnownMarketplaces, upsertKnownMarketplace, removeKnownMarketplace
- 方法/调用入口样本：mkdirSync, writeFileSync, writeKnownMarketplaces, writeKnownMarketplaces
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, writeFileSync

### 152. `plugins/loadPluginHooks.ts`

- 行数：207
- SHA1：`0978927ae736afefeef55e8677d84ae5e7548585`
- 导出：loadPluginHooks
- 类：（无）
- 函数：readHooksJson, matcherAccepts, pluginNameFromKey, loadPluginHooks
- 方法/调用入口样本：（无）
- 核心链路关键词：HookRegistry, scanSkills
- 风险信号关键词：catch {, catch (, path, join(, timeout, silent

### 153. `plugins/marketplaceManager.ts`

- 行数：178
- SHA1：`3ce9673b7e482bd0473d40ab555830b861cbf03b`
- 导出：marketplacesRoot, marketplaceDir, AddMarketplaceResult, addMarketplace, removeMarketplace, loadMarketplace, ListedMarketplace, listMarketplaces
- 类：（无）
- 函数：userHome, marketplacesRoot, marketplaceDir, marketplaceJsonPath, sourceToCloneUrl, addMarketplace, removeMarketplace, loadMarketplace, listMarketplaces
- 方法/调用入口样本：existsSync, mkdirSync, rmSync, rmSync, rmSync, upsertKnownMarketplace, rmSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, catch (, any, path, join(

### 154. `plugins/parseMarketplaceInput.ts`

- 行数：81
- SHA1：`bbb485ebaeaa614ddf19550e4d30ec876f0e1e6e`
- 导出：parseMarketplaceInput, deriveMarketplaceName
- 类：（无）
- 函数：parseMarketplaceInput, deriveMarketplaceName
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, path

### 155. `plugins/pluginCommandHook.ts`

- 行数：253
- SHA1：`49e1be8fcd4cdb06582297d18c057efddc2bf3d8`
- 导出：PluginCommandHookSpec, runPluginCommandHook
- 类：（无）
- 函数：extractAdditionalContext, runPluginCommandHook
- 方法/调用入口样本：resolve, resolve, setTimeout, settle, clearTimeout, settle, clearTimeout, settle, settle, settle, settle, settle, settle
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, catch (, any, path, exec, spawn, timeout

### 156. `plugins/pluginCommandsLoader.ts`

- 行数：141
- SHA1：`cf6808804452ef5086d94655c1f580aa62073b36`
- 导出：PluginCommand, scanPluginCommands, invalidatePluginCommandsCache
- 类：（无）
- 函数：isENOENT, isInaccessible, userHome, readCommandFile, scanOnce, installedPluginsMtime, scanPluginCommands, invalidatePluginCommandsCache
- 方法/调用入口样本：return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, catch (, path, join(

### 157. `plugins/pluginInstaller.ts`

- 行数：377
- SHA1：`317d243882b0224890fd429923a4bc5d249a8153`
- 导出：resolveSafePluginPath, VarRewriteReport, InstallResult, shaMatches, installPlugin, UninstallResult, uninstallPlugin, listInstalled
- 类：（无）
- 函数：userHome, pluginCacheRoot, pluginCacheDir, resolveSafePluginPath, materializePath, materializeGit, materializeGitSubdir, shortSha, shaMatches, materialize, installPlugin, uninstallPlugin, listInstalled
- 方法/调用入口样本：mkdirSync, cpSync, mkdirSync, mkdirSync, cpSync, rmSync, mkdirSync, cpSync, rmSync, mkdirSync, cpSync, rmSync, mkdirSync, cpSync, rmSync, removeInstallEntries, appendInstallEntry, rmSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, path, join(, silent

### 158. `plugins/schemas.ts`

- 行数：150
- SHA1：`9061d92c21b600e64d00448d35aaa6ab6e7bf0fb`
- 导出：validatePluginEntrySource, validatePluginEntry, validateMarketplace
- 类：（无）
- 函数：isObject, validatePluginEntrySource, validatePluginEntry, validateMarketplace
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path

### 159. `plugins/types.ts`

- 行数：58
- SHA1：`5fef23247ab82a79fc1abf655f7e5a85c5befd1f`
- 导出：MarketplaceSource, KnownMarketplace, KnownMarketplaces, PluginEntrySource, PluginMarketplaceEntry, PluginMarketplace, PluginInstallEntry, InstalledPluginsV2, ValidationResult
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path

### 160. `plugins/varRewrite.ts`

- 行数：141
- SHA1：`31d58cb61d15097ba48c5125bc128c7252792df1`
- 导出：RewriteSummary, rewritePluginVars
- 类：（无）
- 函数：isLikelyBinary, walkAndRewrite, rewritePluginVars
- 方法/调用入口样本：walkAndRewrite, writeFileSync, walkAndRewrite, writeFileSync, join
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, path, join(, writeFileSync, permission

### 161. `preset/index.ts`

- 行数：215
- SHA1：`d9b5c165b48f0ccca98c055f811b9a173d3e0f61`
- 导出：AGENT_PRESET_NAMES, BuiltinPresetName, AgentPresetName, AgentPreset, BUILTIN_AGENT_PRESETS, DEFAULT_AGENT_PRESET, DEFAULT_CLI_PRESET, registerPreset, listPresetNames, resolveAgentPreset, buildPresetSystemPrompt, resolveBuiltinToolNames
- 类：（无）
- 函数：registerPreset, listPresetNames, resolveAgentPreset, buildPresetSystemPrompt, resolveBuiltinToolNames
- 方法/调用入口样本：（无）
- 核心链路关键词：Arena
- 风险信号关键词：throw new Error, join(, permission

### 162. `product/define.ts`

- 行数：171
- SHA1：`5941942ed9c726991dfce71db22a36e2464830c9`
- 导出：ProductRuntimeOptions, ProductInstance, defineProduct
- 类：（无）
- 函数：defineProduct
- 方法/调用入口样本：registerPreset
- 核心链路关键词：RunManager, EngineRunner
- 风险信号关键词：path, join(, exec, permission

### 163. `product/index.ts`

- 行数：17
- SHA1：`b214d323a8897bf6c8aff48dcc7d88447baf1215`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 164. `product/types.ts`

- 行数：138
- SHA1：`a8db96fd95ae8d4fe8f7d7311abd12fef03dbb9b`
- 导出：ProductPreset, CustomTool, ProductAdapter, ProductContract, ProductDefinition
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：RunManager
- 风险信号关键词：exec, permission

### 165. `prompt/composer.ts`

- 行数：216
- SHA1：`77c4d0ed4c18e73956455a881380322db3195b2d`
- 导出：ComposerOptions, PromptComposer
- 类：PromptComposer
- 函数：（无）
- 方法/调用入口样本：constructor, buildSystemPrompt, buildUserContextMessage, buildSystemContext, invalidateCache, getSections, getInstructions, getMemoryContext
- 核心链路关键词：PromptComposer, scanSkills
- 风险信号关键词：catch {, any, join(, exec, timeout

### 166. `prompt/instruction-scanner.ts`

- 行数：239
- SHA1：`0b02c46e188fc8786d1432d7ac615375f24560a0`
- 导出：InstructionEntry, ScanOptions, scanInstructions, combineInstructions
- 类：（无）
- 函数：scanInstructions, combineInstructions, tryAddFile, tryAddRulesDir, findGitRoot, collectDirsDownward, dedup, sourceLabel
- 方法/调用入口样本：tryAddFile, tryAddRulesDir, tryAddFile, tryAddRulesDir, tryAddFile, tryAddFile, tryAddRulesDir, tryAddFile, tryAddFile
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, exec, timeout

### 167. `prompt/section-cache.ts`

- 行数：43
- SHA1：`97150d1f8f500a3608f5837c03c5c66b098ed018`
- 导出：PromptSection, SectionCache
- 类：SectionCache
- 函数：（无）
- 方法/调用入口样本：resolve, invalidate, has
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 168. `prompt/section-loader.ts`

- 行数：61
- SHA1：`dab7000c1f0fcc8f189627ed9777b62f161ea498`
- 导出：registerSection, loadSection, loadSections, availableSections
- 类：（无）
- 函数：readSectionFile, registerSection, loadSection, loadSections, availableSections
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, join(

### 169. `prompt/sections/md.d.ts`

- 行数：4
- SHA1：`fccf3295b605175e45426b4fc20291a961a03999`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 170. `protocol/chat-session-manager.ts`

- 行数：98
- SHA1：`1928e593b54810132e7e017831b1319c873dae79`
- 导出：EngineConfigSlice, ChatSessionManagerOptions, ChatSessionManager
- 类：ChatSessionManager
- 函数：（无）
- 方法/调用入口样本：constructor, getOrCreate, get, close, closeAll, sessionCount, sweepIdle, startIdleSweeper, stopIdleSweeper
- 核心链路关键词：SessionManager, ChatSession
- 风险信号关键词：any, as any, permission

### 171. `protocol/chat-session.ts`

- 行数：142
- SHA1：`92939bf18098760b38f8cb980c3e6d62f0841743`
- 导出：ChatSessionOptions, TurnOpts, ChatSession
- 类：ChatSession
- 函数：（无）
- 方法/调用入口样本：constructor, enqueueTurn, cancel, isBusy, requestModelSwitch, queueDepth, pump
- 核心链路关键词：ChatSession
- 风险信号关键词：catch (, any, abort, silent

### 172. `protocol/client.ts`

- 行数：355
- SHA1：`b415846b48dbd9e62f183cb1edf1dd3b56be7da3`
- 导出：AgentClientEvents, AgentRunOptions, BackgroundAgentCompletedHandler, AgentClient
- 类：AgentClient
- 函数：（无）
- 方法/调用入口样本：constructor, run, approve, approve, approve, cancel, configure, query, inject, onStreamEvent, offStreamEvent, onApprovalRequest, offApprovalRequest, onStatus, offStatus, onBackgroundAgentCompleted, handler, offBackgroundAgentCompleted, request, handleResponse
- 核心链路关键词：AgentServer, AgentClient
- 风险信号关键词：permission

### 173. `protocol/factories.ts`

- 行数：121
- SHA1：`e1fe7b1b97ea058e18de62ccc9a46b16f3862712`
- 导出：CreateServerOptions, ServerHandle, createServer, CreateClientOptions, createClient
- 类：（无）
- 函数：createServer, createClient
- 方法/调用入口样本：close, close
- 核心链路关键词：AgentServer, AgentClient
- 风险信号关键词：any, permission, abort

### 174. `protocol/helpers.ts`

- 行数：78
- SHA1：`b47a7ff7121175729496ba12081ad9291d08b10a`
- 导出：InProcessClientHandle, CreateInProcessClientOptions, createInProcessClient
- 类：（无）
- 函数：createInProcessClient
- 方法/调用入口样本：close, close
- 核心链路关键词：RunManager, EngineRunner, AgentServer, AgentClient
- 风险信号关键词：any, path, exec, abort, silent

### 175. `protocol/index.ts`

- 行数：8
- SHA1：`06ad006f936cb47937d4b466c9215e6a712b84da`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：AgentServer, AgentClient
- 风险信号关键词：（无命中）

### 176. `protocol/redact.ts`

- 行数：97
- SHA1：`dc3ebda0a1253d856bdcea6df2301b3a484ca906`
- 导出：makeApiKeyPreview, isSecretKeyPath, maskSecretValue, RedactedLlmConfig, redactLlmConfig
- 类：（无）
- 函数：makeApiKeyPreview, isSecretKeyPath, maskSecretValue, redactLlmConfig
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path

### 177. `protocol/server.ts`

- 行数：1149
- SHA1：`2b15250e478445f23ca8a02167f50ff2cad5050a`
- 导出：AgentServerOptions, AgentServer
- 类：AgentServer
- 函数：isValidPermissionMode
- 方法/调用入口样本：constructor, createErrorResponse, setInteractiveApprovalFn, handleRequest, createErrorResponse, handleRun, handleRunMulti, createErrorResponse, createErrorResponse, createErrorResponse, handleRunLegacy, createErrorResponse, createErrorResponse, createErrorResponse, createErrorResponse, createErrorResponse, handleApprove, createErrorResponse, createErrorResponse, resolve
- 核心链路关键词：ToolRegistry, SessionManager, AgentServer, AgentClient, ChatSession, Arena
- 风险信号关键词：throw new Error, catch {, catch (, any, as any, path, join(, exec, spawn, permission, bypass, timeout, abort

### 178. `protocol/tcp-transport.ts`

- 行数：90
- SHA1：`6860adcf70785b840506ffcb5d98aca0c7445651`
- 导出：SocketTransport, TcpListenResult, listenTcp
- 类：SocketTransport
- 函数：listenTcp
- 方法/调用入口样本：constructor, send, onMessage, close, close, onConnection, resolve
- 核心链路关键词：AgentServer
- 风险信号关键词：catch {, any

### 179. `protocol/transport.ts`

- 行数：109
- SHA1：`28c1b2cc8e70fc958bd6913dba9115fb2a9840c9`
- 导出：Transport, createInProcessTransport, StdioTransport
- 类：StdioTransport
- 函数：createInProcessTransport
- 方法/调用入口样本：send, onMessage, close, send, onMessage, close, send, onMessage, close, constructor, handler, send, onMessage, close
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, spawn

### 180. `protocol/types.ts`

- 行数：332
- SHA1：`018320855f89e327d952b16442c48a138e7b142c`
- 导出：RpcRequest, RpcResponse, RpcNotification, RpcError, RpcMessage, ErrorCodes, RunParams, RunResult, ApproveParams, CancelParams, CloseSessionParams, InjectParams, ConfigureParams, QueryParams, QueryResult, SessionListResult, ToolListResult, ProtocolModelEntry, ProtocolProviderEntry, ConfigResult
- 类：（无）
- 函数：createRequest, createResponse, createErrorResponse, createNotification, isRequest, isResponse, isNotification
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path, permission, bypass

### 181. `remote/bridge.ts`

- 行数：148
- SHA1：`f5c68f45fdf64b7d4c8bdac81d1c39a4e100ba26`
- 导出：BridgeConfig, SpawnFn, buildSSHArgs, RemoteBridge
- 类：RemoteBridge
- 函数：buildSSHArgs
- 方法/调用入口样本：constructor, connect, reject, clearTimeout, resolve, clearTimeout, reject, clearTimeout, reject, send, disconnect
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, catch {, spawn

### 182. `run/ArtifactTracker.ts`

- 行数：188
- SHA1：`82ae5491c48f19077e609b52524a508926a299fa`
- 导出：ArtifactTrackerConfig, ArtifactTracker
- 类：ArtifactTracker
- 函数：extractFileName
- 方法/调用入口样本：constructor, onStreamEvent, getRecordedPaths, processToolResult, recordFileArtifact, extractBashArtifacts
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, exec

### 183. `run/CheckpointWriter.ts`

- 行数：169
- SHA1：`167ea05010737b861c2dd6c027f9194d38ab8fb0`
- 导出：CheckpointWriterConfig, CheckpointWriter
- 类：CheckpointWriter
- 函数：（无）
- 方法/调用入口样本：constructor, onStreamEvent, setSessionId, getTouchedTools, checkPhaseBoundary, writePeriodicCheckpoint, writeCheckpoint, extractSummary
- 核心链路关键词：Engine.run, RunManager, turn_complete
- 风险信号关键词：join(, exec

### 184. `run/EngineRunner.ts`

- 行数：263
- SHA1：`d629220d619f68517c810b37647fcabc2eb66e83`
- 导出：buildHeadlessFlag, AUTOMATION_RUN_SOURCE, AUTOMATION_PROMPT_NOTE, buildAppendSystemPrompt, RunExecutionHandle, RunExecutor, CustomToolEntry, EngineRunnerConfig, EngineRunner
- 类：EngineRunner
- 函数：buildHeadlessFlag, buildAppendSystemPrompt
- 方法/调用入口样本：execute, constructor, execute, onAbort, close
- 核心链路关键词：Engine.run, RunManager, EngineRunner, AgentServer, AgentClient
- 风险信号关键词：any, path, exec, permission, timeout, abort

### 185. `run/Evaluator.ts`

- 行数：107
- SHA1：`18c0b0d41d813aba24a269a00fd9de99e9d935e5`
- 导出：EvaluatorVerdict, EvaluatorResult, EvaluatorContext, Evaluator, NoopEvaluator, CompositeEvaluator
- 类：NoopEvaluator, CompositeEvaluator
- 函数：（无）
- 方法/调用入口样本：evaluate, evaluate, constructor, evaluate
- 核心链路关键词：（无直接命中）
- 风险信号关键词：join(

### 186. `run/FileRunStore.ts`

- 行数：254
- SHA1：`0f4cde9a7cb0a0d0d7bcfa8c9bd8e400fe9c8153`
- 导出：FileRunStore
- 类：FileRunStore
- 函数：（无）
- 方法/调用入口样本：constructor, mkdirSync, runDir, ensureRunDir, mkdirSync, mkdirSync, mkdirSync, mkdirSync, writeJson, writeFileSync, renameSync, rmSync, appendJsonl, appendFileSync, settle, create, update, get, list, join
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, catch (, path, join(, writeFileSync, appendFileSync, renameSync

### 187. `run/Heartbeat.ts`

- 行数：141
- SHA1：`b47c0eea1e9bf2bd2d0689ffacd27adfaee2838c`
- 导出：HeartbeatConfig, HeartbeatData, Heartbeat
- 类：Heartbeat
- 函数：（无）
- 方法/调用入口样本：constructor, start, stop, clearInterval, stopAll, read, isStale, isProcessAlive, write, writeFileSync, remove, unlinkSync, filePath
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, writeFileSync, exec

### 188. `run/RunApprovalBackend.ts`

- 行数：131
- SHA1：`0cfc35d6b35ea6635ce02d71ed24b6d7d2b67e87`
- 导出：PendingApproval, PendingInput, RunLifecycleHooks, RunApprovalBackend, createRunAskUserFn
- 类：RunApprovalBackend
- 函数：createRunAskUserFn
- 方法/调用入口样本：setHooks, setTimeout, requestApproval, resolve, resolveApproval, resolve, hasPendingApproval, resolve
- 核心链路关键词：RunManager
- 风险信号关键词：exec, permission, timeout

### 189. `run/RunLock.ts`

- 行数：164
- SHA1：`1b1bde26d15efb532c9dbd3e299bef35f3e475e2`
- 导出：RunLockConfig, RunLockAcquireResult, RunLock
- 类：RunLock
- 函数：（无）
- 方法/调用入口样本：constructor, acquire, waitForTarget, release, isLocked, forceUnlock, releaseAll, lockTarget
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, catch (, any, path, join(, exec, timeout, silent

### 190. `run/RunManager.ts`

- 行数：776
- SHA1：`9583601e21041b7061f0440ec0bb7a4adc5d0405`
- 导出：RunManagerConfig, RunManager
- 类：RunManager
- 函数：isRunExecutor
- 方法/调用入口样本：constructor, submit, start, resume, cancel, get, list, getEvents, attach, return, recover, shutdown, executeRun, handleApprovalNeeded, handleInputNeeded, transition, emitRunEvent, notifySubscribers, cb, getOrThrow
- 核心链路关键词：Engine.run, RunManager, EngineRunner, session_started
- 风险信号关键词：throw new Error, catch (, any, join(, exec, bypass, blocked, timeout, abort

### 191. `run/RunQueue.ts`

- 行数：96
- SHA1：`7017f0bb8647608d1cba5d4664495cfc9e1398aa`
- 导出：RunQueueConfig, RunQueueExecutor, RunQueue
- 类：RunQueue
- 函数：（无）
- 方法/调用入口样本：constructor, setExecutor, enqueue, cancel, isActive, isPending, drain, queueMicrotask, processNext
- 核心链路关键词：RunManager
- 风险信号关键词：exec

### 192. `run/RunStore.ts`

- 行数：43
- SHA1：`69b2a966458aa730bcefdbe67af29d69d15c9469`
- 导出：RunStore
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：create, update, get, list, delete, appendEvent, listEvents, saveCheckpoint, getLatestCheckpoint, saveApproval, getApproval, getPendingApproval, appendArtifactRef, listArtifactRefs
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 193. `run/factory.ts`

- 行数：120
- SHA1：`3879991bc76edb1ce2d7f6b4cd84403ecfe51fcd`
- 导出：CreateRunManagerOptions, createRunManager
- 类：（无）
- 函数：createRunManager
- 方法/调用入口样本：（无）
- 核心链路关键词：RunManager
- 风险信号关键词：path, join(, exec, permission

### 194. `run/index.ts`

- 行数：76
- SHA1：`5fc6742316d7cbb1e55dacea7593a9481d3d753c`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：RunManager, EngineRunner
- 风险信号关键词：（无命中）

### 195. `run/redirect-target.ts`

- 行数：12
- SHA1：`0e7ed1ee5300923fe8dac5da701915737e8453de`
- 导出：parseRedirectTarget
- 类：（无）
- 函数：parseRedirectTarget
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path

### 196. `run/types.ts`

- 行数：213
- SHA1：`859d4e640547e83c842207f8ba012f76e7b30fbb`
- 导出：RunStatus, RunSnapshot, RunEventType, RunEvent, RunCheckpoint, ApprovalStatus, ApprovalCategory, RunApproval, ArtifactKind, ArtifactRole, RunArtifactRef, SubmitRunInput, ResumeRunInput, ListRunsQuery, RunExecutionContext, RunExecutionResult, RunStreamEvent, RunStreamCallback, DetachFn, VALID_TRANSITIONS
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：EngineRunner
- 风险信号关键词：exec, blocked

### 197. `runtime/safe-spawn.ts`

- 行数：345
- SHA1：`6de9184dac473be3782e8db20d0cf5944ae86ef8`
- 导出：SafeSpawnOptions, SafeSpawnShellOptions, SafeSpawnReason, SafeSpawnResult, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_IO_DRAIN_GRACE_MS, safeSpawn, safeSpawnShell
- 类：（无）
- 函数：safeSpawn, safeSpawnShell, runLifecycle, safeCleanup, emptyResult
- 方法/调用入口样本：safeCleanup, safeCleanup, resolve, finish, setTimeout, setTimeout, clearTimeout, finish, clearTimeout, finish
- 核心链路关键词：ToolExecutor, safeSpawn
- 风险信号关键词：catch {, catch (, any, path, exec, spawn, permission, timeout, abort

### 198. `services/analytics.ts`

- 行数：109
- SHA1：`c4541a9d270f28cc1e3fb699e959c9053603cb32`
- 导出：AnalyticsEvent, analytics, trackEvent
- 类：AnalyticsService
- 函数：fileAnalyticsSink, trackEvent
- 方法/调用入口样本：init, addSink, track, flush, sink, shutdown, clearInterval, return, mkdirSync, appendFileSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, appendFileSync

### 199. `services/auto-dream.ts`

- 行数：152
- SHA1：`788cc5b3725b787d6339c5e7c802c7b3cd561bf7`
- 导出：AutoDreamConfig, shouldAutoDream, recordSession, recordDreamComplete, buildDreamSystemPrompt, buildDreamUserPrompt
- 类：（无）
- 函数：getStateFile, loadState, saveState, shouldAutoDream, recordSession, recordDreamComplete, buildDreamSystemPrompt, buildDreamUserPrompt
- 方法/调用入口样本：mkdirSync, writeFileSync, saveState, saveState
- 核心链路关键词：saveState
- 风险信号关键词：catch {, any, path, join(, writeFileSync, permission

### 200. `services/browser-open.ts`

- 行数：17
- SHA1：`0a483abe7d497e8b14d5762c8254bc9e3f8d9273`
- 导出：browserOpenCommand
- 类：（无）
- 函数：browserOpenCommand
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：exec

### 201. `services/diagnostics.ts`

- 行数：128
- SHA1：`50f8eef696c74d218adac60fe07156db00543722`
- 导出：DiagnosticEntry, diagnostics
- 类：DiagnosticsTracker
- 函数：（无）
- 方法/调用入口样本：constructor, record, recordError, getRecent, getByCategory, generateReport, persist, mkdirSync, appendFileSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, appendFileSync

### 202. `services/dream-consolidation.ts`

- 行数：204
- SHA1：`33bca9e28b24bbce0d3903ad7eaa91f90516b14e`
- 导出：DreamConsolidationInput, DreamConsolidationResult, runDreamConsolidation
- 类：（无）
- 函数：runDreamConsolidation, dispatchDreamTool
- 方法/调用入口样本：return
- 核心链路关键词：Engine.run, ToolRegistry
- 风险信号关键词：catch (, any, path, exec, permission

### 203. `services/extract-memories.ts`

- 行数：89
- SHA1：`880d37e4066796c009d44cc313ea22fa2d67ecff`
- 导出：ExtractedMemory, buildExtractionPrompt, MAX_MEMORIES_PER_EXTRACTION, parseExtractionResponse
- 类：（无）
- 函数：buildExtractionPrompt, parseExtractionResponse
- 方法/调用入口样本：typeof, typeof, typeof
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, as any, join(

### 204. `services/index.ts`

- 行数：38
- SHA1：`5b99c90f21fc295c07920fc364e2f0629d501aba`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：ContextManager
- 风险信号关键词：（无命中）

### 205. `services/memory-orchestrator.ts`

- 行数：176
- SHA1：`4839e4c53743cb64b82c179d32085b9637328b23`
- 导出：MemoryOrchestratorOptions, MemoryOrchestratorResult, MemoryOrchestrator
- 类：MemoryOrchestrator
- 函数：（无）
- 方法/调用入口样本：constructor, run, saveSessionMemory, recordSession, recordDreamComplete
- 核心链路关键词：Engine.run
- 风险信号关键词：catch (, exec

### 206. `services/notifier.ts`

- 行数：102
- SHA1：`0513fde5a692063ec444d31e6d155636f41f0a81`
- 导出：NotificationOptions, notify, escapeAppleScriptString, buildOsascriptArgs, buildNotifySendArgs, buildPowershellArgs, notifyComplete, notifyError
- 类：（无）
- 函数：notify, escapeAppleScriptString, buildOsascriptArgs, buildNotifySendArgs, buildPowershellArgs, notifyComplete, notifyError
- 方法/调用入口样本：execFileSync, execFileSync, execFileSync, notify, notify
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, join(, exec, timeout

### 207. `services/oauth.ts`

- 行数：194
- SHA1：`c0e5b1dfaa1808cfae9f01454c7cad9c271f8d98`
- 导出：OAuthConfig, OAuthTokens, authorize, refreshToken
- 类：（无）
- 函数：generatePKCE, openBrowser, authorize, refreshToken
- 方法/调用入口样本：execFile, reject, clearTimeout, reject, reject, resolve, reject, openBrowser, clearTimeout, reject
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, catch (, join(, exec, timeout

### 208. `services/session-memory-sort.ts`

- 行数：13
- SHA1：`12de87da22d1ce300ef6bde33f6acd8cfa165b35`
- 导出：sortSessionMemoriesByRecency
- 类：（无）
- 函数：sortSessionMemoriesByRecency
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 209. `services/session-memory.ts`

- 行数：99
- SHA1：`a6decd1987ec18b7675517cbc1a7d4e689621151`
- 导出：SessionMemoryEntry, saveSessionMemory, loadSessionMemory, listSessionMemories, searchSessionMemories, buildSessionMemoryPrompt
- 类：（无）
- 函数：saveSessionMemory, loadSessionMemory, listSessionMemories, searchSessionMemories, buildSessionMemoryPrompt
- 方法/调用入口样本：mkdirSync, writeFileSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, writeFileSync

### 210. `session/file-history.ts`

- 行数：135
- SHA1：`c1ab603d0cfc9744afa4984595ef700d4b2b1a65`
- 导出：FileSnapshot, FileHistory
- 类：FileHistory
- 函数：（无）
- 方法/调用入口样本：constructor, mkdirSync, saveSnapshot, copyFileSync, getSnapshots, restore, copyFileSync, restoreLatest, getTrackedFiles, saveIndex, writeFileSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, writeFileSync

### 211. `session/memory.ts`

- 行数：361
- SHA1：`2bc09bdf4398be86958119b5362bfcb42f52df05`
- 导出：MemoryScope, MemoryEntry, MemoryManagerOptions, resolveMemoryBaseDir, MemoryManager
- 类：MemoryManager
- 函数：resolveMemoryBaseDir
- 方法/调用入口样本：constructor, mkdirSync, getMemoryDir, getScope, save, writeFileSync, loadAll, loadFile, delete, mkdirSync, renameSync, getIndex, buildMemoryContext, return, loadScope, loadFileFromDir, migrateFlatLayout, mkdirSync, renameSync, ensureIndexCache
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, writeFileSync, renameSync, permission

### 212. `session/session-manager.ts`

- 行数：370
- SHA1：`f57d3d3055e2549527533c5e5fec2524d4e4453e`
- 导出：SessionBundle, assertSafeSessionId, SessionManager, SessionListEntry
- 类：SessionManager
- 函数：assertSafeSessionId, readLastUserMessage, parseUserPreview
- 方法/调用入口样本：constructor, mkdirSync, create, mkdirSync, writeFileSync, exists, assertSafeSessionId, resume, assertSafeSessionId, saveState, assertSafeSessionId, mkdirSync, writeFileSync, renameSync, fork, list, closeSync, closeSync
- 核心链路关键词：SessionManager, Transcript, ChatSession, saveState
- 风险信号关键词：catch {, any, path, join(, writeFileSync, renameSync

### 213. `session/transcript.ts`

- 行数：216
- SHA1：`cd4f16cb070dbe33b724d913c5c8e81e41496781`
- 导出：Transcript
- 类：Transcript
- 函数：（无）
- 方法/调用入口样本：getFilePath, constructor, mkdirSync, writeFileSync, append, appendMessage, appendToolUse, appendToolResult, appendTurnBoundary, appendSummary, appendError, toMessages, getEvents, flush, appendFileSync, repairToolResultPairs
- 核心链路关键词：Transcript
- 风险信号关键词：catch {, path, writeFileSync, appendFileSync

### 214. `settings/manager.ts`

- 行数：339
- SHA1：`519108ce4ab260211085cdb591928e38895d2e41`
- 导出：SettingsSourceName, SettingsScope, SettingsManager
- 类：SettingsManager
- 函数：userHome, merge
- 方法/调用入口样本：constructor, load, copyFileSync, writeFileSync, get, invalidate, saveUserSetting, mkdirSync, writeFileSync, renameSync, saveProjectSetting, deleteProjectSetting, getForScope, projectSettingsPath, readJsonObject, atomicWriteJson, mkdirSync, writeFileSync, renameSync, loadJsonFile
- 核心链路关键词：SettingsManager
- 风险信号关键词：throw new Error, catch {, any, path, join(, writeFileSync, renameSync, silent

### 215. `settings/schema.ts`

- 行数：361
- SHA1：`15116b1f9e94c6f240a1b5a80906b26816bfa62b`
- 导出：CapabilityOverrideSchema, CapabilityOverride, CapabilityOverridesSchema, CapabilityOverrides, SettingsSchema, ValidatedSettings, validateSettings
- 类：（无）
- 函数：validateSettings
- 方法/调用入口样本：（无）
- 核心链路关键词：Engine.run, MCPManager, PromptComposer, scanSkills
- 风险信号关键词：path, exec, permission, bypass, denied, timeout, silent

### 216. `skills/frontmatter.ts`

- 行数：82
- SHA1：`fe929ec2f24fdb27bdf575d7848265fff46174c0`
- 导出：FRONTMATTER_REGEX, ParsedFrontmatter, parseFrontmatter, quoteProblematicValues, coerceDescription
- 类：（无）
- 函数：parseFrontmatter, quoteProblematicValues, coerceDescription
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, join(

### 217. `skills/index.ts`

- 行数：8
- SHA1：`d53475b07d4fc8da4ff745ee5d7a997fefe9e888`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：scanSkills
- 风险信号关键词：（无命中）

### 218. `skills/scanner.ts`

- 行数：261
- SHA1：`17bb3dab4bca46bb6c8c5b6ac52b13e22dba9ae9`
- 导出：SkillDefinition, ScanSkillsOptions, scanSkills, invalidateSkillCache
- 类：（无）
- 函数：userHome, bases, isENOENT, isInaccessible, readSkillFile, buildSkillFromFile, scanDirBases, scanInstalledPlugins, scanOnce, installedPluginsMtime, scanSkills, invalidateSkillCache
- 方法/调用入口样本：return, buildSkillFromFile, scanDirBases, scanInstalledPlugins
- 核心链路关键词：scanSkills
- 风险信号关键词：catch {, catch (, any, path, join(

### 219. `state.ts`

- 行数：330
- SHA1：`d2b48bdeeb05f0bedf373da16db0d22643b93921`
- 导出：AttributedCounter, ChannelEntry, getSessionId, switchSession, getOriginalCwd, setOriginalCwd, getProjectRoot, setProjectRoot, getCwdState, getIsInteractive, getIsNonInteractiveSession, setIsNonInteractive, getClientType, getSessionTrustAccepted, setSessionTrustAccepted, updateLastInteractionTime, getLastInteractionTime, flushInteractionTime, markScrollActivity, getIsScrollDraining
- 类：（无）
- 函数：getSessionId, switchSession, getOriginalCwd, setOriginalCwd, getProjectRoot, setProjectRoot, getCwdState, getIsInteractive, getIsNonInteractiveSession, setIsNonInteractive, getClientType, getSessionTrustAccepted, setSessionTrustAccepted, updateLastInteractionTime, getLastInteractionTime, flushInteractionTime, markScrollActivity, getIsScrollDraining, waitForScrollIdle, getMainLoopModelOverride
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, as any, path

### 220. `tool-system/builtin/agent-notifications.ts`

- 行数：267
- SHA1：`5096c49f07ecce698a69bd4c67c309253fb11411`
- 导出：NotificationItem, notificationQueue, agentNotificationBus, notificationItemToStreamEvent, buildNotificationMessage, buildNotificationSummary
- 类：NotificationQueue, AgentNotificationBus
- 函数：isValidSessionId, notificationItemToStreamEvent, escapeXmlText, escapeXmlAttr, buildNotificationMessage, buildNotificationSummary
- 方法/调用入口样本：enqueue, return, drainAll, reset, notify, cb, publish, handler, subscribe, return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, as any, path, join(, bypass

### 221. `tool-system/builtin/agent-registry.ts`

- 行数：171
- SHA1：`e02619082230b4dad72f9e4229ed092d361225c6`
- 导出：AsyncAgentStatus, MAX_BACKGROUND_AGENTS, AgentTranscriptEntry, AsyncAgentEntry, asyncAgentRegistry
- 类：AsyncAgentRegistry
- 函数：（无）
- 方法/调用入口样本：return, runningCount, notify, cb, register, appendToTranscript, touchTranscript, get, list, markFinished, markCompleted, markFailed, markCancelled, cancel, reset
- 核心链路关键词：Transcript, RunManager
- 风险信号关键词：catch {, abort

### 222. `tool-system/builtin/agent-transcript-translator.ts`

- 行数：200
- SHA1：`1fd25a4a66d81227d08546b4b626d0f16f820d11`
- 导出：createTranscriptTranslator
- 类：（无）
- 函数：nextId, createTranscriptTranslator, patchEntry, dropEntry, append
- 方法/调用入口样本：return, dropEntry, dropEntry, patchEntry, patchEntry, dropEntry, append, patchEntry, append, patchEntry, dropEntry, dropEntry, append
- 核心链路关键词：Transcript, turn_complete
- 风险信号关键词：any, as any

### 223. `tool-system/builtin/agent.ts`

- 行数：591
- SHA1：`c28596cfd576f2ff5113a17c654d9c7d4baa63b8`
- 导出：AgentTypeOverrides, resolveAgentTypeOverrides, buildAgentTypesBlock, agentToolDefWithTypes, emitSubAgentHook, DEFAULT_SUBAGENT_TIMEOUT_MS, runWithTimeout, agentToolDef, agentTool, agentStatusToolDef, agentStatusTool, agentCancelToolDef, agentCancelTool
- 类：（无）
- 函数：safeEmit, resolveAgentTypeOverrides, buildAgentTypesBlock, agentToolDefWithTypes, emitSubAgentHook, runWithTimeout, runSubAgent, agentTool, agentStatusTool, agentCancelTool
- 方法/调用入口样本：sink, onTimeout, reject, safeEmit, emitSubAgentHook, safeEmit, emitSubAgentHook, runSubAgent, emitSubAgentHook, safeEmit
- 核心链路关键词：Engine.run, TurnLoop, Transcript, HookRegistry
- 风险信号关键词：throw new Error, catch (, any, path, join(, exec, spawn, timeout, abort, fire-and-forget, silent

### 224. `tool-system/builtin/apply-patch/applier.ts`

- 行数：322
- SHA1：`aa5eae6ce9362154944d0a0e908c45231ddc2a39`
- 导出：ApplyPatchOptions, ApplyPatchResult, applyPatch
- 类：（无）
- 函数：applyPatch, planHunks, schedule, applyChunksToText, commitPlanned, writeChange, resolveAgainst, safeStat, readIfExists
- 方法/调用入口样本：schedule, schedule, schedule, schedule, schedule, schedule
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, catch {, catch (, any, path, join(

### 225. `tool-system/builtin/apply-patch/index.ts`

- 行数：129
- SHA1：`b8d6b45a9e7e002f5ec98738b838557780b57c31`
- 导出：applyPatchToolDef, applyPatchTool
- 类：（无）
- 函数：applyPatchTool
- 方法/调用入口样本：（无）
- 核心链路关键词：enforcePathPolicy
- 风险信号关键词：catch (, any, path, join(, blocked

### 226. `tool-system/builtin/apply-patch/parser.ts`

- 行数：303
- SHA1：`1f0127ec30b32e205106fe0bd3eb193ff21d3157`
- 导出：BEGIN_PATCH_MARKER, END_PATCH_MARKER, ADD_FILE_MARKER, DELETE_FILE_MARKER, UPDATE_FILE_MARKER, MOVE_TO_MARKER, EOF_MARKER, CHANGE_CONTEXT_MARKER, EMPTY_CHANGE_CONTEXT_MARKER, ParsedPatch, ParseMode, parsePatch
- 类：（无）
- 函数：parsePatch, checkBoundariesStrict, checkBoundariesLenient, parseOneHunk, parseUpdateChunk
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, any, path, join(

### 227. `tool-system/builtin/apply-patch/seek-sequence.ts`

- 行数：133
- SHA1：`24f93f9ce2ec6bf1253808ba7c8a5b624ac8c8e2`
- 导出：seekSequence
- 类：（无）
- 函数：seekSequence, rtrim, normalize
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 228. `tool-system/builtin/apply-patch/types.ts`

- 行数：62
- SHA1：`da5f43eb571fb6f6d01439f88bdc58c844140eae`
- 导出：Hunk, UpdateFileChunk, PatchParseError, PlannedFileChange
- 类：PatchParseError
- 函数：（无）
- 方法/调用入口样本：constructor, super
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path

### 229. `tool-system/builtin/arena.ts`

- 行数：502
- SHA1：`f0c12266b56558016f8942a929e4d022c271c8dc`
- 导出：arenaToolDef, ArenaStatus, getArenaStatus, arenaTool
- 类：（无）
- 函数：getArenaStatus, resolveParticipant, participantFromPool, probeParticipant, participantWouldResolve, readSettingsParticipants, resolveDefaultParticipantNames, assertEndpointAcceptsModel, inferEndpointVendor, formatStartupBanner, stripAnsi, arenaTool
- 方法/调用入口样本：assertEndpointAcceptsModel, assertEndpointAcceptsModel, participantWouldResolve, return, return
- 核心链路关键词：SettingsManager, Arena
- 风险信号关键词：throw new Error, catch {, catch (, any, path, join(, exec, bypass, abort, silent

### 230. `tool-system/builtin/ask-user.ts`

- 行数：121
- SHA1：`6eba1d423a3ae4c8c784b81dbe553c16eebda6be`
- 导出：askUserToolDef, askUserTool
- 类：（无）
- 函数：askUserTool, parseOptions
- 方法/调用入口样本：return, typeof, typeof
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, exec

### 231. `tool-system/builtin/bash.ts`

- 行数：164
- SHA1：`580d7e7020130ad07616152ce7d026dbdd0ee57e`
- 导出：bashToolDef, bashTool
- 类：（无）
- 函数：buildSandboxEnv, bashTool
- 方法/调用入口样本：（无）
- 核心链路关键词：safeSpawn
- 风险信号关键词：path, exec, spawn, denied, timeout, abort

### 232. `tool-system/builtin/brief.ts`

- 行数：48
- SHA1：`c858612ace00166e3859a96a12504efd4e9a7ed2`
- 导出：briefToolDef, briefTool
- 类：（无）
- 函数：briefTool
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 233. `tool-system/builtin/config.ts`

- 行数：77
- SHA1：`b3a360c0d22b62f16779a8372639bf119ec50dcb`
- 导出：configToolDef, configTool
- 类：（无）
- 函数：configTool
- 方法/调用入口样本：mkdirSync, writeFileSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path, join(, writeFileSync

### 234. `tool-system/builtin/cron.ts`

- 行数：114
- SHA1：`7b042237e837b51eda88272544970a9664e6bcae`
- 导出：cronCreateToolDef, cronCreateTool, cronDeleteToolDef, cronDeleteTool, cronListToolDef, cronListTool
- 类：（无）
- 函数：cronCreateTool, cronDeleteTool, cronListTool
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, join(, exec, permission

### 235. `tool-system/builtin/edit.ts`

- 行数：122
- SHA1：`4dfc66fb38761a9ba9b1d2d0d024058587f85ef0`
- 导出：editToolDef, editTool
- 类：（无）
- 函数：editTool, generateCompactDiff
- 方法/调用入口样本：（无）
- 核心链路关键词：enforcePathPolicy
- 风险信号关键词：catch (, any, path, join(, blocked

### 236. `tool-system/builtin/file-cache.ts`

- 行数：48
- SHA1：`4d9a878dd8d26be99239479cb515ece2876d1e52`
- 导出：fileCache
- 类：FileStateCache
- 函数：（无）
- 方法/调用入口样本：get, set, invalidate, clear
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path

### 237. `tool-system/builtin/generate-image.ts`

- 行数：140
- SHA1：`8a7a84ae2fb350e5f3c5df47659038602e5a3773`
- 导出：generateImageToolDef, generateImageTool
- 类：（无）
- 函数：resolveOpenAIProvider, generateImageTool
- 方法/调用入口样本：return
- 核心链路关键词：SettingsManager
- 风险信号关键词：catch (, any, path, join(

### 238. `tool-system/builtin/glob.ts`

- 行数：97
- SHA1：`0dc068162c2c5e4a0ab20335006674092d3c9394`
- 导出：globToolDef, globTool
- 类：（无）
- 函数：globTool
- 方法/调用入口样本：（无）
- 核心链路关键词：enforcePathPolicy
- 风险信号关键词：catch {, catch (, path, join(, blocked

### 239. `tool-system/builtin/grep.ts`

- 行数：184
- SHA1：`a05e1c0621360e653d2dfdc455b7379097296cd7`
- 导出：grepToolDef, grepTool
- 类：（无）
- 函数：relativizeOutput, isNoMatchExit, grepTool, runRipgrep, runGrep
- 方法/调用入口样本：（无）
- 核心链路关键词：enforcePathPolicy
- 风险信号关键词：catch (, path, join(, exec, blocked, timeout

### 240. `tool-system/builtin/index.ts`

- 行数：493
- SHA1：`44fbff9fb09f4c0680141528485f9c684afc27dc`
- 导出：BuiltinToolFn, BuiltinTool, BUILTIN_TOOLS
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：ToolRegistry, Arena
- 风险信号关键词：any, exec, permission, timeout

### 241. `tool-system/builtin/lsp.ts`

- 行数：154
- SHA1：`5a4c42a8a601c131b36f7d072f2b33518300fd7f`
- 导出：lspToolDef, lspTool
- 类：（无）
- 函数：lspTool, formatLocationResult
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, any, as any, path, join(

### 242. `tool-system/builtin/mcp-tools.ts`

- 行数：116
- SHA1：`9df53d0732937d486e0e658064da28bec280e170`
- 导出：mcpToolDef, mcpToolExecute, listMcpResourcesToolDef, listMcpResourcesTool, readMcpResourceToolDef, readMcpResourceTool
- 类：（无）
- 函数：mcpToolExecute, listMcpResourcesTool, readMcpResourceTool
- 方法/调用入口样本：（无）
- 核心链路关键词：MCPManager
- 风险信号关键词：catch (, any, join(

### 243. `tool-system/builtin/memory.ts`

- 行数：253
- SHA1：`145ff7cf3e0ec1c8a159ab926ee00efd750303d2`
- 导出：memoryListToolDef, memoryListTool, memoryReadToolDef, memoryReadTool, memorySaveToolDef, memorySaveTool, memoryDeleteToolDef, memoryDeleteTool
- 类：（无）
- 函数：parseScope, mmFor, memoryListTool, memoryReadTool, memorySaveTool, memoryDeleteTool
- 方法/调用入口样本：return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, join(, permission

### 244. `tool-system/builtin/notebook-edit.ts`

- 行数：161
- SHA1：`64d5403b8c7c826a7157216ccb17ccb76b1c5cce`
- 导出：notebookEditToolDef, notebookEditTool
- 类：（无）
- 函数：notebookEditTool, readNotebook, writeNotebook, createEmptyNotebook, createCell
- 方法/调用入口样本：writeNotebook, writeNotebook, writeNotebook, writeFileSync
- 核心链路关键词：enforcePathPolicy
- 风险信号关键词：path, join(, writeFileSync, exec, blocked

### 245. `tool-system/builtin/plan.ts`

- 行数：75
- SHA1：`31647289d4af1caadd48c14a859a7aa9a2b12ae9`
- 导出：enterPlanModeToolDef, exitPlanModeToolDef, enterPlanModeTool, exitPlanModeTool
- 类：（无）
- 函数：enterPlanModeTool, exitPlanModeTool
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path, join(

### 246. `tool-system/builtin/powershell.ts`

- 行数：82
- SHA1：`2aeec43459013e7414b883f2ba3c9ad156de364d`
- 导出：powershellToolDef, powershellTool
- 类：（无）
- 函数：powershellTool
- 方法/调用入口样本：（无）
- 核心链路关键词：safeSpawn
- 风险信号关键词：join(, exec, spawn, timeout, abort

### 247. `tool-system/builtin/read.ts`

- 行数：93
- SHA1：`612cca912e0f9a431732a7c4dcdb7923a03892b4`
- 导出：readToolDef, readTool
- 类：（无）
- 函数：readTool
- 方法/调用入口样本：（无）
- 核心链路关键词：enforcePathPolicy
- 风险信号关键词：catch (, path, join(, blocked

### 248. `tool-system/builtin/remote-trigger.ts`

- 行数：63
- SHA1：`f18bb24bc03a6cc0b65d015b8471054fab95598c`
- 导出：remoteTriggerToolDef, remoteTriggerTool
- 类：（无）
- 函数：remoteTriggerTool
- 方法/调用入口样本：mkdirSync, writeFileSync
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (, path, join(, writeFileSync, exec

### 249. `tool-system/builtin/repl.ts`

- 行数：97
- SHA1：`672bcbc2bb7a77ca06e75781a64a1b02af185e1a`
- 导出：replToolDef, replTool
- 类：（无）
- 函数：replTool
- 方法/调用入口样本：（无）
- 核心链路关键词：safeSpawn
- 风险信号关键词：any, as any, join(, exec, spawn, timeout, abort

### 250. `tool-system/builtin/send-message.ts`

- 行数：55
- SHA1：`729bae151ac2a38c8976b525261ccbb0cdfa2119`
- 导出：sendMessageToolDef, sendMessageTool
- 类：（无）
- 函数：sendMessageTool
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：join(, spawn

### 251. `tool-system/builtin/skill-prompt.ts`

- 行数：56
- SHA1：`136522e3063247136eb1ec36db40961944518e72`
- 导出：buildSkillListing
- 类：（无）
- 函数：buildSkillListing
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：join(

### 252. `tool-system/builtin/skill.ts`

- 行数：87
- SHA1：`d002ac89ac071bf8b38758e9e303094958803b01`
- 导出：skillToolDef, skillTool
- 类：（无）
- 函数：skillTool
- 方法/调用入口样本：（无）
- 核心链路关键词：scanSkills
- 风险信号关键词：path

### 253. `tool-system/builtin/sleep.ts`

- 行数：46
- SHA1：`e82f33648cdd918a6a3a9b2c957b657a5b347721`
- 导出：sleepToolDef, sleepTool
- 类：（无）
- 函数：sleepTool
- 方法/调用入口样本：clearTimeout, reject, resolve
- 核心链路关键词：（无直接命中）
- 风险信号关键词：exec, abort

### 254. `tool-system/builtin/task.ts`

- 行数：171
- SHA1：`419344b00d77d0826d01c732499a05dabf2a0575`
- 导出：TaskStatus, TodoItem, Task, todoWriteToolDef, todoWriteTool, readLastTodoSnapshot
- 类：（无）
- 函数：todoWriteTool, parseTodos, toTaskInfos, emitTaskUpdate, readLastTodoSnapshot
- 方法/调用入口样本：emitTaskUpdate
- 核心链路关键词：Transcript
- 风险信号关键词：any, spawn

### 255. `tool-system/builtin/tool-search.ts`

- 行数：110
- SHA1：`3b5abe9097c4bf16e27ebc131ca0766cd0d060a1`
- 导出：toolSearchToolDef, toolSearchTool
- 类：（无）
- 函数：toolSearchTool, matchExact, searchByKeyword, formatTool
- 方法/调用入口样本：return
- 核心链路关键词：ToolRegistry
- 风险信号关键词：join(

### 256. `tool-system/builtin/web-fetch.ts`

- 行数：365
- SHA1：`cab308345238130048d60a8ebb3d2a1f27c15430`
- 导出：webFetchToolDef, __setDnsLookupForTests, webFetchTool
- 类：（无）
- 函数：isBlockedHost, isBlockedIp, isBlockedIpv4, isBlockedIpv6, defaultDnsLookup, __setDnsLookupForTests, validateHopHost, sameOrigin, webFetchTool, readAndTruncateBody, stripCrossOriginHeaders, extractTextFromHTML, decodeEntities
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, catch (, any, join(, dangerous, blocked, timeout, abort, silent

### 257. `tool-system/builtin/web-search.ts`

- 行数：209
- SHA1：`d5324a1803dd230a1622ddbb2ef316a5ee5afbae`
- 导出：SearchProvider, ResolvedSearchConfig, resolveSearchConfig, webSearchToolDef, webSearchTool
- 类：（无）
- 函数：resolveSearchConfig, webSearchTool, searchSerper, searchTavily, searchSearXNG
- 方法/调用入口样本：return, return, return
- 核心链路关键词：SettingsManager
- 风险信号关键词：throw new Error, catch {, catch (, join(

### 258. `tool-system/builtin/worktree.ts`

- 行数：119
- SHA1：`8c7a7c2e34d2e9cfcea48f194e409375f7e567a6`
- 导出：getActiveWorktree, enterWorktreeToolDef, enterWorktreeTool, exitWorktreeToolDef, exitWorktreeTool
- 类：（无）
- 函数：getActiveWorktree, enterWorktreeTool, exitWorktreeTool
- 方法/调用入口样本：validateWorktreeSlug, return, removeWorktree, removeWorktree, return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (

### 259. `tool-system/builtin/write.ts`

- 行数：49
- SHA1：`10f7a6745ddcc4dac25f2e5451772fa0a00b58fe`
- 导出：writeToolDef, writeTool
- 类：（无）
- 函数：writeTool
- 方法/调用入口样本：（无）
- 核心链路关键词：enforcePathPolicy
- 风险信号关键词：catch (, path, blocked

### 260. `tool-system/context.ts`

- 行数：208
- SHA1：`7ed9c5c54907e84f1f9cc79d155d1d1eabf2d052`
- 导出：AskUserChoice, AskUserOptions, AskUserFn, SubAgentSpawnRequest, SubAgentSpawner, ToolContext, ServiceContainer
- 类：ServiceContainer
- 函数：（无）
- 方法/调用入口样本：spawn, describe, constructor, get, withSignal
- 核心链路关键词：Engine.run, ToolExecutor, ToolRegistry, HookRegistry, Arena
- 风险信号关键词：any, path, exec, spawn, permission

### 261. `tool-system/executor.ts`

- 行数：505
- SHA1：`e5a93ef3b52669f0b44e2d0f2b5240dfea9e3c8d`
- 导出：ToolExecutor
- 类：ToolExecutor
- 函数：clampHookDecision
- 方法/调用入口样本：constructor, setInvestigationGuard, getInvestigationGuard, setTaskGuard, getTaskGuard, setSignal, setContext, setLogger, isConcurrencySafe, executeSingle, recordToolCall, recordToolResult, recordToolResult, isReadOnlyBashCommand, resultsToMessages
- 核心链路关键词：TurnLoop, ToolExecutor, PermissionClassifier, ToolRegistry, HookRegistry
- 风险信号关键词：catch (, any, path, join(, exec, permission, denied, blocked, abort, silent

### 262. `tool-system/investigation-guard.ts`

- 行数：178
- SHA1：`731aae094bf2469b6cfcc1d7144b689962948f72`
- 导出：GuardDecision, InvestigationGuard
- 类：InvestigationGuard
- 函数：（无）
- 方法/调用入口样本：setSoftMode, preToolCheck, noteText, noteToolResult, turnEnded, return, isMutatingTool, buildKey
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path, join(, silent

### 263. `tool-system/mcp-manager.ts`

- 行数：414
- SHA1：`2ca4f4153efa657992fc3878dc7bf1fa2d433a45`
- 导出：spillMcpImage, wrapMcpOutput, buildRegisteredTool, MCPManager
- 类：MCPManager
- 函数：spillMcpImage, wrapMcpOutput, buildRegisteredTool
- 方法/调用入口样本：constructor, connectAll, connect, reject, discoverTools, disconnectAll, listServers, callTool, listResources, readResource
- 核心链路关键词：ToolRegistry, MCPManager
- 风险信号关键词：TODO, throw new Error, catch {, catch (, any, path, join(, exec, permission, timeout, TODO

### 264. `tool-system/path-policy.ts`

- 行数：321
- SHA1：`8ebd26dcf705bca21abe8af1c2e9237f44f389e7`
- 导出：PathDecision, PathOperation, PathClassification, ClassifyOptions, classifyPath, enforcePathPolicy, __resetPathPolicyWarnLatchForTests
- 类：（无）
- 函数：policyDisabled, expandTilde, safeRealpath, isInsideDir, matchSensitiveDir, matchSensitiveFile, isSafeCodeShellDiagnosticRead, classifyPath, enforcePathPolicy, __resetPathPolicyWarnLatchForTests
- 方法/调用入口样本：（无）
- 核心链路关键词：ToolRegistry, enforcePathPolicy
- 风险信号关键词：catch {, any, path, permission, bypass, denied, blocked, silent

### 265. `tool-system/permission.ts`

- 行数：862
- SHA1：`b3ce62c32843b9179ff658d9a8747c5f480c60f5`
- 导出：ApprovalBackend, HeadlessApprovalBackend, AutoApprovalBackend, InteractiveApprovalBackend, getInteractiveApprovalBackend, setInteractiveApprovalFn, classifyBashCommand, DenialTracker, ACCEPT_EDITS_ALLOWLIST, PermissionClassifier
- 类：HeadlessApprovalBackend, AutoApprovalBackend, InteractiveApprovalBackend, DenialTracker, PermissionClassifier
- 函数：buildProjectRule, escapeRegex, persistProjectRule, getInteractiveApprovalBackend, setInteractiveApprovalFn, scanShellCommand, classifySegment, minSafety, classifyBashCommand
- 方法/调用入口样本：requestApproval, constructor, requestApproval, constructor, requestApproval, isSafeOperation, setPromptFn, hasPromptFn, setCwd, setOnProjectRules, requestApproval, persistProjectRule, getInteractiveApprovalBackend, flush, flush, flush, flush, constructor, record, recordSuccess
- 核心链路关键词：PermissionClassifier
- 风险信号关键词：catch {, catch (, any, path, writeFileSync, renameSync, exec, permission, bypass, dangerous, denied, silent

### 266. `tool-system/plan-mode-allowlist.ts`

- 行数：43
- SHA1：`262686e20829fd976b13312a796991aea54e30c8`
- 导出：PLAN_MODE_ALLOWED_TOOLS
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, exec

### 267. `tool-system/registry.ts`

- 行数：167
- SHA1：`6df9161e2a48e78eb17c4ef659da01f362ed0e38`
- 导出：DEFAULT_TOOL_TIMEOUT_MS, ToolRegistryOptions, ToolRegistry
- 类：ToolRegistry
- 函数：（无）
- 方法/调用入口样本：constructor, registerBuiltins, registerTool, getToolDefinitions, getTool, hasTool, executeTool, executor, reject, clearTimeout, clearTimeout, listTools, listToolsDetailed
- 核心链路关键词：ToolRegistry, Arena
- 风险信号关键词：catch (, any, join(, exec, timeout, abort

### 268. `tool-system/sandbox/bwrap.ts`

- 行数：74
- SHA1：`32394d9fe8906e761424b810f4f87a4386a2cf43`
- 导出：createBwrapBackend
- 类：（无）
- 函数：createBwrapBackend
- 方法/调用入口样本：wrap, hintForBlockedOutput, return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, spawn, denied, blocked

### 269. `tool-system/sandbox/index.ts`

- 行数：277
- SHA1：`95c6ab75c7252e9e9c791cb64b1dacdf3f2112da`
- 导出：SandboxMode, SandboxNetworkPolicy, SandboxConfig, SandboxBackend, detectSandboxCapabilities, expandPath, expandConfig, defaultSandboxConfig, resolveSandboxBackend
- 类：（无）
- 函数：detectSandboxCapabilities, binaryExists, expandPath, canonicalize, expandConfig, warnAutoDowngrade, defaultSandboxConfig, resolveSandboxBackend, warnMissingWritableRoots
- 方法/调用入口样本：wrap, accessSync, warnAutoDowngrade, warnMissingWritableRoots, warnMissingWritableRoots, accessSync
- 核心链路关键词：Engine.run
- 风险信号关键词：catch {, any, path, exec, spawn, permission, denied, blocked, silent

### 270. `tool-system/sandbox/off.ts`

- 行数：10
- SHA1：`0abe6bd647c4f0c22df7b3794c105d318e7cbf66`
- 导出：createOffBackend
- 类：（无）
- 函数：createOffBackend
- 方法/调用入口样本：wrap
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 271. `tool-system/sandbox/seatbelt.ts`

- 行数：117
- SHA1：`da54e7e636a69bd86b601997ec31eb6b896473ea`
- 导出：createSeatbeltBackend
- 类：（无）
- 函数：createSeatbeltBackend, buildProfile, quote
- 方法/调用入口样本：wrap, writeFileSync, rmSync, hintForBlockedOutput, return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, path, join(, writeFileSync, exec, spawn, denied, blocked

### 272. `tool-system/task-guard.ts`

- 行数：84
- SHA1：`995be20b036458d2ba7202b71fe6724ee71b3081`
- 导出：TaskGuard
- 类：TaskGuard
- 函数：（无）
- 方法/调用入口样本：constructor, turnEnded, return, reset
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, join(

### 273. `tool-system/validation.ts`

- 行数：57
- SHA1：`f7aed4e5a3153c3f67da77d22833dc8aaa900014`
- 导出：validateToolArgs
- 类：（无）
- 函数：validateToolArgs
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any

### 274. `types.ts`

- 行数：480
- SHA1：`319c849ec1064d0d4d9d37b297c1aca1c15901c1`
- 导出：ContentBlock, Message, ToolDefinition, ToolCall, ToolResult, ToolSource, RegisteredTool, TranscriptEventType, TranscriptEvent, SessionStatus, SessionState, TokenUsage, CompiledInput, InputOptions, Attachment, ImageAttachment, PermissionDecision, PermissionMode, PermissionRule, ApprovalRequest
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：MCPManager, Transcript, turn_complete, session_started
- 风险信号关键词：path, exec, spawn, permission, bypass, timeout, abort, fire-and-forget

### 275. `updater.ts`

- 行数：430
- SHA1：`5d9b25f78903f7b733c175ffdcb8ec17403c12d8`
- 导出：UpdateInfo, checkForUpdate, getUpdateAvailable, getAutoUpdateDisabledReason, scheduleAutoInstallOnExit, getCurrentVersion, __internal
- 类：（无）
- 函数：checkForUpdate, getUpdateAvailable, getAutoUpdateDisabledReason, scheduleAutoInstallOnExit, getCurrentVersion, resolveVersion, runCheck, getLatestVersion, checkGlobalInstallPermissions, userHome, configDir, getLockFilePath, getUpdateLogPath, acquireLock, releaseLock, launchDetachedInstall, isAutoUpdaterDisabled, readAutoUpdatesFlagFromDisk, isEnvTruthy, errnoCode
- 方法/调用入口样本：launchDetachedInstall
- 核心链路关键词：SettingsManager
- 风险信号关键词：catch {, catch (, path, join(, writeFileSync, exec, spawn, permission, timeout, silent

### 276. `utils/debug.ts`

- 行数：124
- SHA1：`e87bb60361833758941f0dc60ac3d51c1c8a1c98`
- 导出：DebugLogLevel, setDebugSessionId, isDebugMode, enableDebugLogging, isDebugToStdErr, getMinDebugLogLevel, logForDebugging, debugCategory, debugTiming, logAntError, getDebugFilePath, setHasFormattedOutput, getHasFormattedOutput, flushDebugLogs
- 类：（无）
- 函数：setDebugSessionId, isDebugMode, enableDebugLogging, isDebugToStdErr, getMinDebugLogLevel, logForDebugging, debugCategory, debugTiming, logAntError, getDebugFilePath, setHasFormattedOutput, getHasFormattedOutput, flushDebugLogs
- 方法/调用入口样本：return, return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch (

### 277. `utils/earlyInput.ts`

- 行数：191
- SHA1：`ced342917eddfd7be9dd11adfeb960ea406a7b68`
- 导出：startCapturingEarlyInput, stopCapturingEarlyInput, consumeEarlyInput, hasEarlyInput, seedEarlyInput, isCapturingEarlyInput
- 类：（无）
- 函数：startCapturingEarlyInput, processChunk, stopCapturingEarlyInput, consumeEarlyInput, hasEarlyInput, seedEarlyInput, isCapturingEarlyInput
- 方法/调用入口样本：processChunk, stopCapturingEarlyInput, stopCapturingEarlyInput, stopCapturingEarlyInput
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, silent

### 278. `utils/env.ts`

- 行数：112
- SHA1：`197566cf6a68c4ddfd36fb46c99569634efbefbf`
- 导出：env, getHostPlatform, getHostPlatformForAnalytics, isWSL, getGlobalClaudeDir, getGlobalCodeShellDir, getGlobalClaudeFile, getRuntime, getPackageManager, hasInternetAccess, JETBRAINS_IDES, isJetBrainsTerminal, isVSCodeTerminal
- 类：（无）
- 函数：getHostPlatform, getHostPlatformForAnalytics, isWSL, getGlobalClaudeDir, getGlobalCodeShellDir, getGlobalClaudeFile, getRuntime, getPackageManager, hasInternetAccess, isJetBrainsTerminal, isVSCodeTerminal
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {, any, as any, path, join(, exec, timeout

### 279. `utils/envUtils.ts`

- 行数：159
- SHA1：`8e9addd775ae4bc769ff7aae795fff7db1c25856`
- 导出：getClaudeConfigHomeDir, getTeamsDir, isEnvTruthy, isEnvDefinedFalsy, hasNodeOption, isBareMode, parseEnvVars, getAWSRegion, getDefaultVertexRegion, shouldMaintainProjectWorkingDir, isRunningOnHomespace, getVertexRegionForModel, isInProtectedNamespace
- 类：（无）
- 函数：getClaudeConfigHomeDir, getTeamsDir, isEnvTruthy, isEnvDefinedFalsy, hasNodeOption, isBareMode, parseEnvVars, getAWSRegion, getDefaultVertexRegion, shouldMaintainProjectWorkingDir, isRunningOnHomespace, getVertexRegionForModel, isInProtectedNamespace
- 方法/调用入口样本：return, isEnvTruthy, return, isEnvTruthy
- 核心链路关键词：（无直接命中）
- 风险信号关键词：throw new Error, path, join(

### 280. `utils/execFileNoThrow.ts`

- 行数：105
- SHA1：`f1bb6aa6924ff5134aa5287a669f48aec142aab9`
- 导出：ExecFileNoThrowResult, ExecFileNoThrowOptions, execFileNoThrow, execFileNoThrowWithCwd, execSyncWithDefaults_DEPRECATED
- 类：（无）
- 函数：execFileNoThrow, execFileNoThrowWithCwd, execSyncWithDefaults_DEPRECATED
- 方法/调用入口样本：resolve, resolve, resolve
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, as any, exec, spawn, permission, denied, timeout

### 281. `utils/format.ts`

- 行数：300
- SHA1：`326a75b24d745dae353d71ecf3f2bdfc7479452e`
- 导出：formatFileSize, formatSecondsShort, formatDuration, formatNumber, formatTokens, formatRelativeTime, formatRelativeTimeAgo, formatLogMetadata, formatResetTime, formatResetText
- 类：（无）
- 函数：formatFileSize, formatSecondsShort, formatDuration, formatNumber, formatTokens, formatRelativeTime, formatRelativeTimeAgo, formatLogMetadata, formatResetTime, formatResetText
- 方法/调用入口样本：formatRelativeTimeAgo, return, return
- 核心链路关键词：（无直接命中）
- 风险信号关键词：join(

### 282. `utils/intl.ts`

- 行数：94
- SHA1：`b8f3a8370fe5dc78b1573dfd123c11ac34daca34`
- 导出：getGraphemeSegmenter, firstGrapheme, lastGrapheme, getWordSegmenter, getRelativeTimeFormat, getTimeZone, getSystemLocaleLanguage
- 类：（无）
- 函数：getGraphemeSegmenter, firstGrapheme, lastGrapheme, getWordSegmenter, getRelativeTimeFormat, getTimeZone, getSystemLocaleLanguage
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：catch {

### 283. `utils/lockfile.ts`

- 行数：51
- SHA1：`e31b5013a900abc0e20a1ca1239dc9d22d416950`
- 导出：lock, lockSync, unlock, check
- 类：（无）
- 函数：getLockfile, lock, lockSync, unlock, check
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, silent

### 284. `utils/memoize.ts`

- 行数：35
- SHA1：`5d0c3933837a66db61b13dd2a91bafd0f56138d6`
- 导出：MemoizedFn, memoize
- 类：（无）
- 函数：memoize
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 285. `utils/semver.ts`

- 行数：17
- SHA1：`2933d30d7e7872b24b2b146e08cf00a86b7fbb66`
- 导出：gte, gt, lt
- 类：（无）
- 函数：gte, gt, lt
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 286. `utils/sliceAnsi.ts`

- 行数：71
- SHA1：`ccb99e3c98fc4e9d97d3313da9ece5103476c114`
- 导出：（无显式命名导出）
- 类：（无）
- 函数：（无）
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：any, path, exec

### 287. `utils/systemTheme.ts`

- 行数：119
- SHA1：`f821d103614bc8b2626a5259719decfe099921f9`
- 导出：SystemTheme, getSystemThemeName, setCachedSystemTheme, resolveThemeSetting, themeFromOscColor
- 类：（无）
- 函数：getSystemThemeName, setCachedSystemTheme, resolveThemeSetting, themeFromOscColor, parseOscRgb, hexComponent, detectFromColorFgBg
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：exec

### 288. `utils/task-sanitizer.ts`

- 行数：34
- SHA1：`8231d5e2d30d848828e71d70f69bd5fc86ecb5b8`
- 导出：NoiseResult, detectPastedNoise
- 类：（无）
- 函数：detectPastedNoise
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：（无命中）

### 289. `utils/theme.ts`

- 行数：658
- SHA1：`838bb0558c55b01d478b1a9276abed6cd67657fe`
- 导出：Theme, THEME_NAMES, ThemeName, THEME_SETTINGS, ThemeSetting, getTheme, themeColorToAnsi, rgbToXterm256
- 类：（无）
- 函数：getTheme, themeColorToAnsi, rgbToXterm256
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：permission

### 290. `utils/toolDisplay.ts`

- 行数：210
- SHA1：`9955194797e96c448dee03d8fad20b998d6e9a6a`
- 导出：MAX_PREVIEW_LINES, MAX_LINE_WIDTH, TOOL_DOT_COLORS, formatToolArgs, truncate, singleLine, formatBytes, CompactResult, compactOutput
- 类：（无）
- 函数：relativizePath, stripCdPrefix, formatToolArgs, truncate, singleLine, formatBytes, compactOutput
- 方法/调用入口样本：（无）
- 核心链路关键词：（无直接命中）
- 风险信号关键词：path, join(


---

## 2026-06-10 校对补遗

> 上面 #1–#290 的逐文件详条生成于 2026-06-02。截至 2026-06-10，core 实际非测试文件已增至 **319** 个。下面补记本次校对发现的差异;详条(SHA/导出)未逐一回填,仅列路径与实测行数,后续可重新生成。

**已删除/改名(原清单仍列,现已不存在):**
- `agent/coordinator.ts`(多代理 coordinator 死代码,随 SendMessage 一并删除)
- `tool-system/builtin/send-message.ts`(SendMessage 工具已删)

**新增但未进上面编号清单的 31 个文件:**
- `engine/dynamic-tool-defs.ts` — 39 行
- `engine/friendly-error.ts` — 85 行
- `engine/goal.ts` — 255 行
- `external-agents/config.ts` — 22 行
- `external-agents/types.ts` — 37 行
- `llm/capabilities/reasoning-control.ts` — 58 行
- `llm/provider-auth.ts` — 97 行
- `llm/reasoning-setting.ts` — 38 行
- `review/review-prompt.ts` — 110 行
- `runtime/background-shell.ts` — 542 行
- `runtime/output-clean.ts` — 45 行
- `runtime/ring-file.ts` — 188 行
- `runtime/spawn-common.ts` — 201 行
- `runtime/truncate-output.ts` — 60 行
- `session/simple-diff.ts` — 87 行
- `session/undo-target.ts` — 49 行
- `settings/disk-defaults.ts` — 63 行
- `settings/feature-flags.ts` — 75 行
- `settings/migrate-config.ts` — 90 行
- `settings/personalization.ts` — 20 行
- `tool-system/builtin/add-marketplace.ts` — 82 行
- `tool-system/builtin/agent-output-file.ts` — 91 行
- `tool-system/builtin/apply-patch/backup-targets.ts` — 31 行
- `tool-system/builtin/background-shell-tools.ts` — 126 行
- `tool-system/builtin/bash-output-style.ts` — 50 行
- `tool-system/builtin/complete-goal.ts` — 54 行
- `tool-system/builtin/generate-video.ts` — 304 行
- `tool-system/builtin/image-providers.ts` — 178 行
- `tool-system/builtin/update-automation-memory.ts` — 69 行
- `tool-system/builtin/video-providers.ts` — 237 行
- `tool-system/builtin/view-image.ts` — 112 行

---

## 入口链路调用核验表

| 链路 | 文件 | 关键词命中 | 缺失 |
|---|---|---|---|
| SDK barrel exports | `index.ts` | Engine, createLLMClient, AgentServer, AgentClient, createRunManager, ToolRegistry | 无 |
| Engine run orchestration | `engine/engine.ts` | async run, createLLMClient, new ToolExecutor, new ContextManager, PromptComposer, connectAll, new TurnLoop, turnLoop.run, on_session_end, turn_complete | 无 |
| TurnLoop model/tool loop | `engine/turn-loop.ts` | async run, manageAsync, callModelWithFallback, toolCalls, execute, on_stop, max_turns, turn_complete | 无 |
| Tool execution chain | `tool-system/executor.ts` | executeSingle, pre_tool_use, PermissionClassifier, on_permission_check, registry.executeTool, post_tool_use | 无 |
| Permission classification | `tool-system/permission.ts` | classifyBashCommand, ACCEPT_EDITS_ALLOWLIST, class PermissionClassifier, classify( | 无 |
| Tool registry execution | `tool-system/registry.ts` | class ToolRegistry, registerBuiltins, executeTool, timeout | 无 |
| MCP discovery/call | `tool-system/mcp-manager.ts` | class MCPManager, connectAll, discoverTools, client.callTool, callTool( | 无 |
| Protocol server run | `protocol/server.ts` | class AgentServer, handleRun, handleRunMulti, handleRunLegacy, handleApprove, handleQuery | 无 |
| Protocol client request | `protocol/client.ts` | class AgentClient, async run, request(, handleNotification | 无 |
| Chat session queue | `protocol/chat-session.ts` | class ChatSession, enqueueTurn, pump, engine.run, cancel | 无 |
| Run manager execution | `run/RunManager.ts` | class RunManager, submit, executeRun, session_started, waiting_approval, completed, failed, blocked | 无 |
| Engine runner bridge | `run/EngineRunner.ts` | class EngineRunner, new Engine, AgentServer, AgentClient, client.run | 无 |
| LLM factory | `llm/client-factory.ts` | createLLMClient, PROVIDER_REGISTRY, anthropic, openai | 无 |
| OpenAI provider | `llm/providers/openai.ts` | class OpenAIClient, createMessage, buildRequestBody, stream_options, toolCalls | 无 |
| Anthropic provider | `llm/providers/anthropic.ts` | class AnthropicClient, createMessage, messages.create, messages.stream | 无 |
| Capability rules | `llm/capabilities/rules.ts` | RULES, openai, deepseek, anthropic, openrouter, maxOutputTokens | 无 |
| Context manager | `context/manager.ts` | class ContextManager, manageAsync, applyToolResultPersistence, microcompact, applySummaryCompaction | 无 |
| Transcript/session | `session/transcript.ts` | class Transcript, append, toMessages, repairToolResultPairs, flush | 无 |
| Session manager | `session/session-manager.ts` | class SessionManager, assertSafeSessionId, create, resume, saveState, fork | 无 |
| Settings manager | `settings/manager.ts` | class SettingsManager, load, saveUserSetting, getForScope, merge | 无 |
| Prompt composer | `prompt/composer.ts` | class PromptComposer, buildSystemPrompt, buildUserContextMessage, scanSkills | 无 |
| Hook registry | `hooks/registry.ts` | class HookRegistry, register, emit, deny, continueSession | 无 |
| Plugin hooks | `plugins/loadPluginHooks.ts` | loadPluginHooks, PreToolUse, PreCompact, Stop, runPluginCommandHook | 无 |
| Skills scanner | `skills/scanner.ts` | scanSkills, disabledSkills, disabledPlugins, frontmatter | 无 |
| Automation scheduler | `automation/scheduler.ts` | class CronScheduler, create, loadJobs, delete, nextRun | 无 |
| Arena | `arena/arena.ts` | class Arena, async run, planArena, runParticipantResearchWithDossiers, buildConsensus | 无 |
