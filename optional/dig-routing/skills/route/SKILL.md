---
name: route
description: Route Dig research and saved-report lookups to the current or connected computer. Use when the user requests Dig, retained-evidence research, or reuse of prior Dig reports, including from a dot or cloud chat. Keep the existing local library and return findings to the requesting conversation.
---

# Route work to Dig

This optional skill locates the installed Dig plugin and sends work to the computer that can run it. It supplies no research server, credentials, or computer-access grant. The installed Dig skills own the research method and evidence checks.

## Choose where the work runs

1. Check the host's available tools and skill discovery for Dig. If this conversation already exposes Dig's `source_info` and `library_list`, work here. Load the installed `$dig:dig` skill for research or `$dig:library` for saved-report lookup; honor a source-specific skill the user named. Do not create another task just because this skill was selected.
2. If Dig is unavailable here, use the host's connected-computer inventory to find an online computer with access already granted. Use the host's supported local Work/Codex task delegation according to its authorization requirements. Target that computer explicitly; a cloud coding environment does not have its Dig installation or library. Do not invent a tool, host ID, project path, or an access grant. If several computers could contain the intended library and the user's context does not distinguish them, clarify the destination.
3. If there is no authorized online computer, local-task interface, or installed Dig, explain the specific missing prerequisite. Ask for the connection/setup step only when needed. Do not install Dig, enable sources, copy credentials, or substitute a different provider or Dig edition to make the request appear successful.

For a dot, the documented connection is its profile → Computers → Your computer → Allow access. That grant is separate from ordinary Codex connections. The computer must remain online with ChatGPT open. Discovery and task creation depend on the host; this skill does not make a local plugin automatically visible to a cloud dot.

## Give the local task a complete assignment

Send the user's question, purpose, relevant context, supplied links, requested sources, freshness requirements, existing report references, and any spending or privacy limits. Pass the following execution instructions:

> Use the installed Dig plugin on this computer. Load `$dig:dig` for research or `$dig:library` for lookup. Check `source_info` for enabled sources and prerequisites. Use the actual absolute project directory from this local task, or the user's explicitly mapped local project; do not use a cloud path or the plugin/cache directory. Preserve the user's source and spending choices. Read relied-on reports completely and check load-bearing claims against retained originals as the Dig skill requires. Return the answer, source citations, saved-report references and any returned Dig links, plus material limits and incomplete work. A filename alone is not the result.

For lookup-only requests, use the existing library without starting new provider calls. A request to research does not authorize enabling disabled sources, new credentials, deep-research jobs, or other scope expansions. Do not send private context to a provider unless it is necessary and within the user's request.

## Deliver to the requesting conversation

Keep the local task reference and follow it using the host's task-status tools. If interrupted, inspect that task before creating another one; do not duplicate paid research. A local task receiving this skill should use its own Dig tools or report that they are unavailable, not forward the assignment again.

Return the findings and citations in the original conversation, with the computer used, report references, and any failed or unverified parts. Carry through the local task's evidence limits. Do not claim the cloud agent independently read a local file it could not access. A `codex://` report link may open only on the desktop; include enough of the answer and underlying source links to be useful without it.

Connection help: [Computers and apps for dots](https://learn.chatgpt.com/docs/dots/computers-and-apps). Task behavior: [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory).
