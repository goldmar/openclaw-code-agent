import { resolveGoalVerification, verifierSpecCommands } from "../src/goal-verifier-policy";
import type { GoalTaskState } from "../src/types";

/** Build modern fixture state explicitly; production never adopts old active rows. */
export async function bindGoalTask(task: GoalTaskState): Promise<GoalTaskState> {
  const baseline = await resolveGoalVerification(task.workdir);
  const commands = verifierSpecCommands(task.verifierCommands ?? [], true);
  const matches = JSON.stringify(commands.slice(0, baseline.binding.requiredCommands.length)) === JSON.stringify(baseline.binding.requiredCommands);
  const additional = matches ? (task.verifierCommands ?? []).slice(baseline.binding.requiredCommands.length) : [];
  const selection = await resolveGoalVerification(task.workdir, additional);
  return { ...task, goalVerificationBinding: selection.binding };
}
