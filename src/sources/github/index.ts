import { defineSource, type SourcePlugin } from "../../core/plugin.ts";
import { githubInspectAction } from "./inspect.ts";
import { githubReadAction } from "./read.ts";
import { githubSearchAction } from "./search.ts";

export { resetGhCliTokenCache } from "./client.ts";
export { githubInspectAction, githubInspectSchema } from "./inspect.ts";
export { githubReadAction, githubReadSchema } from "./read.ts";
export { githubSearchAction, githubSearchSchema } from "./search.ts";

export const githubSource: SourcePlugin = defineSource({
  id: "github",
  group: "code",
  label: "GitHub",
  description: "Discover, compare and read public repositories",
  about:
    "Finds, compares and reads public repositories: repository search, a repository's activity over a window (stars, commits, releases, contributors, review and issue samples) and single files at an exact commit.",
  providers: [{ name: "GitHub REST and GraphQL APIs", url: "https://docs.github.com/en/rest" }],
  billing:
    "Free. Works without a login at GitHub's lower anonymous limits; a token in keys.env or a gh login raises them and adds review and issue-reply samples.",
  logo: "github",
  env: ["GH_TOKEN", "GITHUB_TOKEN"],
  optionalKeys: [
    {
      names: ["GH_TOKEN", "GITHUB_TOKEN"],
      whenAbsent:
        "No GH_TOKEN or GITHUB_TOKEN in keys.env. Public REST search and reads still work, anonymously or through an existing gh login; readiness does not run gh, so a gh login was not probed. A token, or a gh login, raises GitHub's rate limits and adds the review and issue-reply samples.",
    },
  ],
  credential: "GH_TOKEN or GITHUB_TOKEN, or an existing gh login",
  actions: [githubSearchAction, githubInspectAction, githubReadAction],
});

export default githubSource;
