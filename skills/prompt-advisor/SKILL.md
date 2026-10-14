---
name: prompt-advisor
description: Explain or configure Prompt Advisor, Joey's BB plugin for reviewing new-thread prompts and recommending model, reasoning, speed, project and machine changes.
---

# Prompt Advisor

The plugin reviews the new-thread composer automatically after a pause, or via **Review now** / **Review prompt and settings**. Its canonical review rubric is `lib/review.ts` in the plugin source. Preserve the user's intent, scope and permissions; never fill missing facts with invented requirements. Review reasoning and service tier separately.

Read the plugin README for workflow and limits. Recommendations are advisory. Never claim a prompt or setting changed until the user applies it and BB's selectors settle. A skill invocation alone does not authorize starting a task or applying settings.

Configure only settings the user requests:

```sh
bb plugin config prompt-advisor set autoReview true
bb plugin config prompt-advisor set reviewerModel gpt-6.1-sol
bb plugin config prompt-advisor set reviewerReasoning medium
bb plugin config prompt-advisor set reviewerTier ultrafast
```

The reviewer model/machine are distinct from the task's model/machine. Missing catalogue data or low confidence must be disclosed. Do not inspect provider credentials or raw diagnostic logs to diagnose a failed review; check only provider availability and supported model options on the selected host.
