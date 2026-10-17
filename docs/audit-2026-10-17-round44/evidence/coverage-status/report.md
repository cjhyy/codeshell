Current primary workspace coverage status, captured 2026-10-17T15:10:51Z. This is a conservative historical JSON metadata lower bound, not a complete count of what remains unaudited.

| Current TS/TSX path status | Files |
| --- | ---: |
| Exact SHA permits carrying explicit-full source-row claims | 288 |
| Exact SHA permits carrying explicit-selected claims, with no full claim | 150 |
| This index cannot confirm semantic coverage | 4205 |
| Total current filesystem paths under this filter | 4643 |

The current root is /Users/admin/Documents/个人学习/代码学习/codeshell. [Inventory](current-inventory.json) uses the identical Round49 filter: rg --files --hidden with *.ts/*.tsx, explicit .git/node_modules exclusions and normal repository ignores. It includes tests/docs/helper TS and is a dated filesystem set, not a Git tracked inventory or behavior/line coverage. Each file was read as bytes only to compute path/length/SHA/line count; no source body was decoded, displayed, parsed or executed.

[Summary](summary.json) and [comparison](comparison.json) carry a Round49 initial full/selected claim only when its exact SHA matches now and its path was not invalidated by the Round49 ending overlay. Nine changed old paths and one added test path agree with that overlay; no initial path was removed. No old claim was revived and no new version was automatically upgraded. The four [frozen inputs](input-pins.json) remain byte-identical and were not modified. [Checks](checks.json) verifies the count sum and input hashes; the semantic [source manifest](source-manifest.json) has files=[]/0 lines.

All MD-only full evidence and later Round43/48/50 semantic reading have not been merged into this method. Therefore 4205 does not mean never read, not reviewed, unfinished or buggy. Likewise the 4355 paths lacking a carryable full claim are not a verified count of actual unfinished files. These counts are the available metadata categories only. Actual remaining audit work requires reconciling the broader history and defining the review unit/depth.

Only this exact new tmp directory was written. Product/helper/import/fixture/test/UI/native/network/Git operations: 0. No product bug list or current-unfixed defect count is inferred here. [Receipt](artifact-receipt.json) freezes this status snapshot.
