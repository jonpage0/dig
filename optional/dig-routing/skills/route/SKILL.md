---
name: route
description: Route Dig research and saved-report lookups to the current or connected computer. Use when the user requests Dig, retained-evidence research, or reuse of prior Dig reports, including from a dot or cloud chat. Keep the existing local library and return findings to the requesting conversation.
---

# Route work to Dig

This optional skill finds a Dig connection and sends work to the computer that runs Dig. It supplies no research server, credentials, or computer-access grant. Dig's own methods own the research method and evidence checks.

## Choose where the work runs

1. Check the host's available tools for Dig. If this conversation already exposes Dig's `source_info`, `library_list` and `method` tools, work here. Read Dig's `dig` method (`method({ name: "dig" })`) for research or its `library` method for saved-report lookup; honor a source method the user named. Do not create another task just because this skill was selected.
2. If Dig is unavailable here, use the host's connected-computer inventory to find an online computer with access already granted. Use the host's supported local Work/Codex task delegation according to its authorization requirements. Target that computer explicitly; a cloud coding environment does not have its Dig installation or library. Do not invent a tool, host ID, project path, or an access grant. If several computers could contain the intended library and the user's context does not distinguish them, clarify the destination.
3. If there is no authorized online computer, local-task interface, or Dig connection there, explain the specific missing prerequisite. Ask for the connection/setup step only when needed. Do not install Dig, enable sources, copy credentials, or substitute a different provider or Dig edition to make the request appear successful.

For a dot, the documented connection is its profile → Computers → Your computer → Allow access. That grant is separate from ordinary Codex connections. The computer must remain online with ChatGPT open. Discovery and task creation depend on the host; this skill does not make a local Dig connection visible to a cloud dot.

## Give the local task a complete assignment

Send the user's question, purpose, relevant context, supplied links, requested sources, freshness requirements, existing report references, and any spending or privacy limits. Pass the following execution instructions:

> Use Dig's tools on this computer. Read Dig's `dig` method (`method({ name: "dig" })`) for research or its `library` method for lookup. Check `source_info` for enabled sources and prerequisites. Give `dig_start` the actual absolute project directory of this local task, or the user's explicitly mapped local project; never a cloud path or Dig's own program folder. Preserve the user's source and spending choices. Read relied-on reports completely and check load-bearing claims against retained originals as Dig's method requires. Return the answer, source citations, saved-report references and the dig handle, plus material limits and incomplete work. A filename alone is not the result.

For lookup-only requests, use the existing library without starting new provider calls. A request to research does not authorize enabling disabled sources, new credentials, deep-research jobs, or other scope expansions. Do not send private context to a provider unless it is necessary and within the user's request.

## Deliver to the requesting conversation

Keep the local task reference and follow it using the host's task-status tools. If interrupted, inspect that task before creating another one; do not duplicate paid research. A local task receiving this skill should use its own Dig tools or report that they are unavailable, not forward the assignment again.

Return the findings and citations in the original conversation, with the computer used, report references, and any failed or unverified parts. Carry through the local task's evidence limits. Do not claim the cloud agent independently read a local file it could not access. Dig's `dig://` links and saved reports are readable only through the Dig connection on that computer; include enough of the answer and underlying source links to be useful without them.

Connection help: [Computers and apps for dots](https://learn.chatgpt.com/docs/dots/computers-and-apps). Task behavior: [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory).
