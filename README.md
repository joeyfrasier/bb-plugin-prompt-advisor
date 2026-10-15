# Prompt Advisor

A personal fork of [Prompt Enhancer](https://github.com/vburojevic/bb-plugin-prompt-enhancer) for BB 0.46+. It reviews the initial draft of a new thread and recommends changes to the task's model, reasoning, speed tier, project, and machine.

Review on demand with **Ctrl+Shift+R** (the Control key on macOS too, shown as ⌃⇧R), **Review now**, or the composer's **Review prompt and settings** send-menu entry. The shortcut is a BB composer command, so it can be rebound in BB's keyboard settings. Automatic review also runs after one minute without typing, but only when the draft ends on a finished sentence (terminal punctuation, a closing quote or bracket, or a closed code fence); drafts that stop mid-sentence wait for you. Follow-up messages are unaffected.

The reviewer rewrites the draft into the prompt an agent should receive: goal first, the supplied context stated once, each request as its own instruction, and the deliverable and boundaries made explicit. It keeps your voice, scope, and authorization (an investigation never becomes permission to change things) and never completes an unfinished sentence or invents facts.

The review shows only the proposed changes: the rewritten prompt (**Show changes** highlights deletions and insertions against your draft), each setting change as `current → proposed`, and any questions. The reasons are under **Why these changes**, collapsed by default.

Questions come with likely answers. Pick one or type your own, then **Update prompt with answer** (or press Enter): the review runs again with your answers, which are folded into the prompt rather than appended. Unanswered questions stay open.

Select the changes you want. **Apply** updates the draft and pickers with an Undo option; **Apply & start** starts the task after those selections settle. **Keep original** dismisses the review. BB's normal Send remains available and sends your current draft; review is advisory, not a mandatory submission gate.

The management skill is kept as source documentation (`bb.skills: []`) and is not installed; the plugin's automatic review uses its built-in rubric and does not require an installed skill.

## Settings

Settings → Plugins → Prompt Advisor exposes automatic review, the pause duration (default 60,000 ms), review provider/model/reasoning/service tier/machine, and your prompt/routing preferences. Defaults are Codex, `gpt-6.1-sol`, medium reasoning, and `ultrafast`, on the BB server machine. These review settings are independent of the settings recommended for the actual task.

Tasks that need any tool access receive a recommendation for **high reasoning or higher**, even for a small Jira lookup, a repository edit, browsing, or a test run. Already-high settings are retained; lower reasoning is reserved for work completed entirely from supplied text. Recommendations must fit the final model and machine, and still require your explicit Apply selection.

Only connected machines with an existing project source (or personal workspace) are offered. Model support is checked for that machine; workspace-scoped options are offered only for the currently selected environment. Reviews never provision machines or clone projects. Unavailable catalogues are disclosed, and recommendations below 75% confidence require manual selection. Core BB remains the authority on picker reconciliation and provider availability.

Review results become stale when you edit the draft, mentions, attachments, environment, or selected settings. Settings are checked again against live catalogues before application. File paths, inline commands, links and structured mention text must survive rewriting. Applying a project/machine recommendation is blocked while the draft carries attachments or checkout-specific mention/command pills. Change those selectors manually and review again so references can be revalidated. Uploaded attachments are preserved; the reviewer receives their count, not their contents.

The reviewer is instructed to review only, without tools or task execution, in a hidden personal-workspace BB thread with Accept Edits permissions. The draft, selected settings, relevant project/source names and paths, and bounded model/machine metadata are sent to the configured model provider through BB. This uses your existing provider account, not a separate classifier API. It is not a capability-isolated inference endpoint: BB's normal provider session and instruction handling still apply.

Pending reviews survive switching away and plugin reloads. Hidden reviewer threads are stopped/deleted on completion, error, dismissal, or timeout, with recovery for interrupted launches. Successful cleanup clears the stored child ID; old terminal records are deleted on the next plugin load after seven days. No raw provider error or credential-bearing state is logged.

## Development

```sh
npm ci --include=dev
bb plugin types --check
npm test
npm run typecheck
npm run format:check
bb plugin build .
bb plugin install . --yes
```

Current SDK declarations come from the pinned `@get-bb/plugin-sdk` package. Backend tests use its real SQLite/RPC lifecycle harness; frontend tests use its composer harness. `verification/preview.tsx` renders the actual component with synthetic data for desktop/mobile visual checks, without creating tasks; select a state with `?state=idle|unfinished|pending|ready|answered|good|applied`. Those checks do not replace live BB picker testing.

The original MIT license and attribution are retained. This fork has a distinct `prompt-advisor` plugin identity, so it can coexist with upstream Prompt Enhancer. Magic Compose may continue suggesting routing; this review snapshots its currently selected values and applies changes only when requested.
