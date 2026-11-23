/** What start_session checks before anything is sent. */

/** A failure the assistant can act on: answered as a tool error. */
export class StartRefusal extends Error {
  override name = "StartRefusal"
}

/** owner/name on GitHub. */
export const GITHUB_REPO =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/
/** A cloud environment's (or a self-hosted pool's) id, as list_environments answers them. */
export const ENVIRONMENT_ID = /^[A-Za-z][A-Za-z0-9_-]{2,127}$/
/** A branch name, conservatively. */
export const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/

/**
 * A repository, a branch and a task that is not blank. The task is a JSON
 * message, so a leading / or ! is nothing special.
 */
export function checkStart(repo: string, task: string, branch: string): void {
  if (task.trim() === "")
    throw new StartRefusal("task is the first message: say what to do.")
  if (!GITHUB_REPO.test(repo))
    throw new StartRefusal("repo is a GitHub repository, as owner/name.")
  if (!BRANCH.test(branch))
    throw new StartRefusal("branch is a branch name, like main.")
}
