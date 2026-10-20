# Dig routing (optional)

An instruction-only companion to [Dig](../../README.md). It teaches an agent to use Dig in the current conversation when its tools are available, or send the task to an authorized connected computer and bring the result back. Automatic skill selection is enabled.

## Install locally

With the Dig marketplace already registered:

```sh
codex plugin marketplace upgrade dig
codex plugin add dig-routing@dig
```

For a local checkout, register its root with `codex plugin marketplace add /absolute/path/to/dig`, then run `codex plugin add dig-routing@dig`. Install the main Dig plugin separately on the computer that will run the research. The routing plugin has no MCP server, credentials or library of its own, and installing Dig does not install this companion.

Refresh skill discovery or start a new conversation. The explicit invocation is `$dig-routing:route`. A matching request can select the skill automatically once the host has made it available.

To remove only this companion:

```sh
codex plugin remove dig-routing@dig
```

## Using it with a dot

Connect the computer through the dot's profile → Computers → Your computer → Allow access, and keep it online with ChatGPT open. The skill uses the host's existing local-task delegation; it does not grant computer access or create a remote Dig server.

**Local installation verifies local discovery only.** It does not establish that a cloud dot sees this skill before it creates a local task. The portable `plugin.json` and `skills/` folder also form a standalone instruction-only package for a supported private account-plugin upload. Availability to the cloud dot and a complete local-task round trip must be tested in that host; no account upload is performed by these installation commands.

The package intentionally has no `requires_local_executor` flag or hard dependency on Dig's MCP tools: the routing instructions can be read in the cloud, while Dig itself executes on the connected computer. If the host cannot delegate locally, the skill explains what is missing rather than simulating an installation or sending credentials elsewhere.

See [OpenAI's dot connection documentation](https://learn.chatgpt.com/docs/dots/computers-and-apps) and [task routing documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory).
