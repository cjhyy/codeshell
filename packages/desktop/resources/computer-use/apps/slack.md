---
id: slack
bundleIds: [com.tinyspeck.slackmacgap]
names: [Slack]
stage:
  perch: beside-target
  keepClear: [text]
---

## Slack

- Return in the message composer sends the message. Put message text in the composer with `set_value`; `type_text` text containing a newline can send it early.
- Before pressing Return, make sure the intended field is focused; with nothing focused, typed text goes into the composer.
- Never send, post, edit or react unless the user asked for that exact message.
- If the accessibility tree looks inconsistent, trust the screenshot.
