# Link source reads

Link provides generic, permission-gated evidence reads. A Panel can submit a
request through `agent.submitPrompt`; the current Agent discovers the selected
connection with `LinkAction`, reads authorized material, and writes reviewed
structured records through `Panel` tools. Domain schemas, decisions, questions,
confirmation of personal responsibility and public resume content belong in the
Panel package. No credentials are returned to the Panel. `agent.task` does not
currently allow `LinkAction` and is not a background Link ingestion path.

## Actions

| Provider / action                  | Parameters                                                                                          | Result                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack `get_message`                | `permalink`                                                                                         | One exact message, author ID, timestamp, optional parent timestamp and rereadable permalink.                                                  |
| Slack `get_thread`                 | `channel`, parent `ts`; optional `permalink`, `cursor`, `limit` (default/max 15)                    | One page of parent/replies, their author IDs, timestamps, parent linkage and permalinks; `next_cursor`, `has_more`, `truncated`.              |
| GitHub `list_pull_request_files`   | `owner`, `repo`, `pull_number`; optional `page` (default 1, max 100), `limit` (default 30, max 100) | One page of filenames, changes, actual text `patch`, availability and truncation flags.                                                       |
| GitHub `list_pull_request_commits` | Same PR parameters                                                                                  | One page of exact SHAs, GitHub author/committer identities, Git author/committer name/email/date, commit messages and verification summaries. |
| GitHub `get_commit`                | `owner`, `repo`, full 40-character `sha`; optional `page`, `limit` as above                         | Exact commit attribution, stats and one file/patch page. Mutable refs and abbreviated SHAs are rejected.                                      |

Every new result contains `provenance` with `provider`, `action`, `source_url`
and `fetched_at`. Slack also includes `channel` and requested `ts`; GitHub includes
the page. Existing account selection remains in `LinkAction.connectionId`. A
client should preserve the connection/account label alongside the result when
storing provenance; normalization does not infer the selected account or
whether an author is the user.

Reads make no automatic pagination requests or retries. Callers deliberately
request the next page, preserve each page's provenance, and keep incomplete
evidence marked. Slack replies are at most 15 messages per request and text is
capped at 16 Ki characters per message (`text_truncated`). GitHub patches are
capped at 16 Ki characters per file and 128 Ki characters per response; missing
patches have `patch_available: false`, separately from `patch_truncated`.
Commit messages are capped at 16 Ki characters (`message_truncated`). Existing
HTTP response size/time limits continue to apply.

GitHub's JSON body does not carry the pagination Link header through every
transport, so a full page conservatively reports `has_more: true` and a possible
`next_page`; the extra page can be empty. `truncated` also marks later pages as
partial views. `upstream_limit` records GitHub's limits: 250 commits per PR,
3,000 PR files or commit files. Reaching a provider limit does not establish
complete history. A PR file patch describes the PR at fetch time; use exact
commit SHAs for stable contribution evidence. GitHub identity and a patch do not
by themselves establish ownership, decision-making responsibility or impact.

## Slack exact identity

Only HTTPS workspace `*.slack.com/archives/<channel>/p<timestamp>` permalinks are
accepted. API requests always go to fixed `https://slack.com/api/` methods;
supplied URLs are identifiers, never fetch destinations. The selected account's
`chat.getPermalink` response must match the channel, timestamp and supplied
workspace origin. Neighboring messages never satisfy an exact message read.

A reply link must include `thread_ts` to locate the parent. Returned reply
permalinks retain `thread_ts` and `cid` so they can be read again. For a copied
reply link without that query, supply the known parent through `get_thread`;
do not substitute nearby channel history. Thread cursors are opaque, bounded
strings; each response belongs to the selected channel and parent timestamp.

Channel history and thread replies use the appropriate `*:history` scopes.
Slack may require a user token for public/private channel replies even when a
bot can read channel history. Missing scopes, unavailable/deleted history,
retention limits and rate limits surface as provider errors; no inferred
discussion fills those gaps. `chat.getPermalink` supplies the canonical source.

## Transport and authorization

Direct Token/OAuth execution, GitHub CLI execution, and remote Link normalization
share input validation and result normalization. Remote resource grants are
checked before requests, including extracting the channel from a Slack URL;
new actions do not widen existing grants. A remote Link service must implement
and explicitly advertise these action IDs and scopes before clients can use
them. Adding a local manifest does not upgrade a deployed remote service.

For new GitHub actions the remote service returns upstream GitHub JSON
arrays/objects. Slack services return an envelope with `messages`, `has_more`,
optional `response_metadata.next_cursor` (or `next_cursor`) and a `permalink`
obtained from `chat.getPermalink` for the requested message or parent. The client
normalizes this envelope and validates exact identity again. Existing saved
connections may need verification or reauthorization to acquire newly offered
capabilities; they never silently gain new scopes.

Protocol references: [Slack history](https://docs.slack.dev/reference/methods/conversations.history/),
[Slack replies](https://docs.slack.dev/reference/methods/conversations.replies/),
[Slack permalinks](https://docs.slack.dev/reference/methods/chat.getPermalink/),
[GitHub PR files](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files),
[GitHub PR commits](https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request),
[GitHub exact commit](https://docs.github.com/en/rest/commits/commits#get-a-commit).
