# Round30 Intl/helper prep

Parent context b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0, not a future formal baseline. **0new formal/0candidate/0new-related**; product code unchanged.

Full Intl leaf94 lines, selected format139–300(162), earlyInput60–110(51) and internal export60–90(31):338 ordinary source lines, plus the complete old R14 utils report. All4 product paths were byte-pinned before those semantic ranges; dedicated old-report pin followed history excerpt inspection, initialSemanticReadSha256=null. [Manifest](source-manifest.json) and [original timing correction](metadata-notes.json) preserve this distinction.

Intl lazily caches segmenters by fixed granularity and relative formatters by style/numeric; system locale caches unavailable as undefined. first/last helpers delegate to grapheme segments and handle empty strings. Selected lastGrapheme consumer removes the returned segment length. This is source-only, with no Intl constructors, locale platform, TTY/stdin capture or product function execution.

Relative-time/reset formatting consumers use English formats consistently; package search shows the relative/reset/log metadata helper family references its own definitions and formatter helper calls, without a current live caller for these options. showTime=false in the short reset branch and relative short-style concerns exactly match R14's already-excluded clue. Lacking a stronger ordinary production consumer, this is no new candidate. [Decisions](decisions.json) preserve the old boundary. No old i18n/Slice/CLI failed dynamic direction was resumed.

[Prep history](history.json):2765 files,1275MD/1490JSON,562917strings/833428scalars,169exact archives,0parse. Excludes mutable29/future30, matches Intl111/display-option15/old-failed133, retained100/15/100 cap100. All15 display-option contexts were inspected and R14 directly read; keyword/capped navigation is not historical semantic exhaustion. No full inventory rescan; old pin-only coverage was a selection hint, not proof of first review.

[Validation](validation.json) has no runs,0tests/pass/expect/import/function/fixture/native/model/real tasks. Only files/hash/JSON/regex metadata operations occurred. Prep preserves its original parent/time; formalization must separately bind the then-current baseline and current history.
