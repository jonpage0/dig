# Research permissions

Dig's source selection and the host's permission policy are separate controls. Enabling a source makes its tools discoverable; Codex or Claude Code still decides whether a caller may invoke them.

Local provider tools are marked as contacting external services and retaining local evidence. Their annotations are not changed to avoid approval. Some are keyless, some have metered budgets and some require paid credentials; a keyless request can still require host consent. Source readiness reports presence, not permission, credential validity or an available balance.

## Interactive use

In a host that permits approval prompts, approve the intended source action when asked. Codex supports plugin-scoped, per-server and per-tool approval policies, so users can deliberately permit a specific source tool rather than grant blanket permission to every source. Managed workspace policies may constrain those choices.

Approval policy belongs to Codex, not Dig's TOML settings. Installing this plugin does not rewrite the user's approval policy or grant source tools permission.

Official reference: https://learn.chatgpt.com/docs/extend/mcp#plugin-provided-mcp-servers

In Claude Code, Claude Code's own permission settings decide whether a Dig tool may run, in the same way. Installing Dig there adds no permission rule and grants no tool permission.

## Unattended use and tests

A host that cannot ask for approval refuses a call its policy does not allow. Headless `codex exec` under approval policy `never` rejects a Dig tool call that needs approval: the provider receives no request, and no search result or raw receipt exists. The worker reports the refusal as a refusal, not as a provider outage or empty evidence.

Codex's `--approve-for-me` routes approval requests through automatic review with workspace-write permissions. That is a supported review route, not a bypass flag. A reviewer's rejection must be honored and reported; it is not permission to switch to bypass flags or to call the same provider through another interface.

Another supported unattended option is deliberately configured, narrowly scoped prior permission for the needed tool. Do not install that policy silently. Keep paid provider decisions and unrelated tool permissions independent.

## Method failure handling

Workers must distinguish a host permission refusal, a provider/network failure, cancellation and an empty completed search. They must never invent results or a saved path. A save argument validation error can be corrected without another provider call. The optional report topic is a lowercase hyphenated string of at most 50 characters.
